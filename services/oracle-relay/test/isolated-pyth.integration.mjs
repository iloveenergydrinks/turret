import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {CASHCAT_PAIR,probePair} from '../src/isolated-pyth-preflight.mjs';
import {prepareIsolatedPublication} from '../src/isolated-publication.mjs';
import {IsolatedOracleTransactions,verificationValueReserved} from '../src/isolated-transactions.mjs';
import {IsolatedOracleWorker} from '../src/isolated-worker.mjs';
import {readIsolatedReadiness} from '../src/isolated-readiness.mjs';
import {Store} from '../../liquidator/src/store.mjs';
import {PYTH_VERIFIER} from '../src/pyth.mjs';
import {payload,wrapPayload} from './fixtures/isolated-pyth.mjs';
import {verifyOracleWiring} from '../../../contracts/utils/verify-isolated-oracle-wiring.mjs';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
const {createPublicClient,createWalletClient,http,keccak256,toHex}=require('viem');
const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');
const artifact=(file,name)=>JSON.parse(readFileSync(new URL(`../../../contracts/out/${file}/${name}.json`,import.meta.url)));

test('local signed preflight agrees with actual ratio adapter and rejects forged reports',{timeout:120000},async()=>{
  const reservation=createServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  // Fresh loopback-only chain. No fork, production credentials, or external writes.
  const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','4663','--accounts','0','--silent'],{stdio:'ignore'});
  let spawnError;child.on('error',error=>{spawnError=error;});
  const client=createPublicClient({transport:http(`http://127.0.0.1:${port}`,{timeout:3000,retryCount:0}),cacheTime:0,pollingInterval:30});
  const directory=mkdtempSync(join(tmpdir(),'dockyard-oracle-publication-'));let store;
  try {
    let started=false;
    for(let i=0;i<100;i++){
      if(spawnError||child.exitCode!==null)throw Error('Local Anvil unavailable');
      try{if(await client.getChainId()===4663){started=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(started);assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
    const account=privateKeyToAccount(generatePrivateKey()),provider=privateKeyToAccount(generatePrivateKey());
    await client.request({method:'anvil_setBalance',params:[account.address,toHex(10n**19n)]});
    const wallet=createWalletClient({account,transport:http(`http://127.0.0.1:${port}`)});
    const deploy=async(a,args)=>{
      const hash=await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,chain:null});
      const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');return receipt.contractAddress;
    };
    const token=artifact('DockyardUSDGCreditVault.t.sol','DockyardMockERC20');
    for(const [target,decimals] of [[CASHCAT_PAIR.collateral,18],[CASHCAT_PAIR.usdg,6]]){
      const deployed=await deploy(token,['Local mock','MOCK',decimals]);
      await client.request({method:'anvil_setCode',params:[target,await client.getCode({address:deployed})]});
    }
    const verifier=await deploy(artifact('DockyardOracleV2.t.sol','SignedPythFixture'),[provider.address]);
    const code=await client.getCode({address:verifier});
    await client.request({method:'anvil_setCode',params:[PYTH_VERIFIER,code]});
    const hubArtifact=artifact('DockyardPythVerifier.sol','DockyardPythVerifier');
    const hub=await deploy(hubArtifact,[PYTH_VERIFIER]);
    const adapterArtifact=artifact('DockyardPythUsdRatioFeed.sol','DockyardPythUsdRatioFeed');
    const {collateralSymbol,usdgSymbol,...config}=CASHCAT_PAIR;
    const adapter=await deploy(adapterArtifact,[{hub,...config}]);
    await client.request({method:'anvil_mine',params:['0x3']});
    let clock=(await client.getBlock()).timestamp;
    const symbols=()=>[[collateralSymbol,3441,2],[usdgSymbol,232,3]].map(([symbol,id,minimum])=>({
      symbol,pyth_lazer_id:id,state:'stable',instrument_type:'spot',asset_type:'crypto',exponent:-8,min_publishers:minimum,
    }));
    const signed=async(values,signer=provider)=>{
      const data=payload(values),signature=Buffer.from((await signer.sign({hash:keccak256(toHex(data))})).slice(2),'hex');
      signature[64]-=27;return wrapPayload(data,signature);
    };
    const args={client,key:'local-placeholder',verifierCodeHash:keccak256(code),caller:account.address,
      now:()=>Number(clock*1000n),getSymbols:async()=>symbols()};
    const quote=()=>client.readContract({address:adapter,abi:adapterArtifact.abi,functionName:'latestRoundData'});
    const publicationArgs={...args,policy:CASHCAT_PAIR,hub,adapter,
      hubCodeHash:keccak256(await client.getCode({address:hub})),adapterCodeHash:keccak256(await client.getCode({address:adapter})),
      collateralCodeHash:keccak256(await client.getCode({address:CASHCAT_PAIR.collateral})),usdgCodeHash:keccak256(await client.getCode({address:CASHCAT_PAIR.usdg}))};
    const identity={kind:'isolated-oracle-test',hub,account:account.address};
    store=new Store(directory,identity);store.acquireLease();
    const txConfig={mode:'execute',chainId:4663,publication:publicationArgs,confirmations:2n,relayAddress:account.address,
      maxTxFee:10n**15n,maxDailyGas:10n**18n,maxDailyVerificationValue:20000000000000n,minEth:1n,replaceAfterMs:10000,maxReplacements:3,
      alertWebhook:'https://local-fixture.invalid',alertCheckMs:300000,cycleMaxAgeMs:30000};
    const chain={client,wallet,account,consistent:true,select:()=>client.getBlock()};
    let transactions=new IsolatedOracleTransactions(chain,store,txConfig,{now:()=>Number(clock*1000n)});
    const alerts={async deliver(){return true;},async update(incidents){store.set('alertDelivery',{delivered:true});return incidents;}};
    const post=async plan=>{
      // Actual worker cache checks + durable transaction manager; only the
      // provider response (already authenticated above) and alert transport are fixtures.
      const worker=new IsolatedOracleWorker({chain,store,txs:transactions,alerts,config:txConfig,
        now:()=>Number(clock*1000n),prepare:async()=>plan});
      await worker.cycle();
      const pending=store.pendingTx();assert.equal(pending.kind,'isolated_oracle_update');
      assert.equal((await client.waitForTransactionReceipt({hash:pending.attempts[0].hash})).status,'success');
      await client.request({method:'anvil_mine',params:['0x3']});
      clock=(await client.getBlock()).timestamp;
      // Reopen the same private journal, then reconcile in observe mode. No
      // resubmission is needed to establish what the mined update actually did.
      store.close();store=new Store(directory,identity);store.acquireLease();
      const observer={...chain,account:{address:account.address},wallet:undefined};
      transactions=new IsolatedOracleTransactions(observer,store,{...txConfig,mode:'observe'},{now:()=>Number(clock*1000n)});
      const recovery=new IsolatedOracleWorker({chain:observer,store,txs:transactions,alerts,config:{...txConfig,mode:'observe'},
        now:()=>Number(clock*1000n),prepare:async()=>plan});
      assert.equal((await recovery.cycle()).ready,false,'watch-only recovery cannot claim an executing relay');
      assert.equal(store.pendingTx(),undefined);
      const confirmed=store.transactions().find(tx=>tx.id===pending.id);
      assert.equal(confirmed.status,'confirmed');
      assert.equal(confirmed.verificationFeeConfirmedAt,Number(clock*1000n));
      assert.equal(verificationValueReserved(store.transactions(),Number(clock*1000n)),
        store.transactions().reduce((sum,tx)=>sum+tx.request.value,0n),'confirmed value reservations survive journal restart');
      assert.deepEqual(confirmed.publicationResult.updatedFeedIds,[3441,232]);
      assert.deepEqual(confirmed.publicationResult.supersededFeedIds,[]);
      transactions=new IsolatedOracleTransactions(chain,store,txConfig,{now:()=>Number(clock*1000n)});
    };
    for(const scenario of ['regular','depeg','closed','recovery','wide-confidence','old-source']){
      clock+=5n;
      await client.request({method:'evm_setNextBlockTimestamp',params:[Number(clock)]});
      await client.request({method:'evm_mine',params:[]});
      const base={timestampUs:clock*1000000n,sourceUs:clock*1000000n,confidence:10000n,exponent:-8,publishers:3,session:0};
      const feeds=[{...base,id:3441,price:200000000n},{...base,id:232,price:scenario==='depeg'?80000000n:100000000n}];
      if(scenario==='closed')feeds[0].session=4;
      if(scenario==='wide-confidence')feeds[0].confidence=3000000n;
      if(scenario==='old-source')feeds[0].sourceUs-=60000000n;
      const update=await signed(feeds),before=await client.getTransactionCount({address:account.address});
      const result=await probePair({...args,getPrices:async()=>({signed:update})});
      assert.equal(await client.getTransactionCount({address:account.address}),before,'preflight must not send a transaction');
      const publication=await prepareIsolatedPublication({...publicationArgs,getPrices:async()=>({signed:update})});
      assert.equal(publication.shouldSubmit,true,scenario);
      assert.equal(await client.getTransactionCount({address:account.address}),before,'publication preparation must not sign');
      await post(publication);
      clock=(await client.getBlock()).timestamp;
      const duplicate=await prepareIsolatedPublication({...publicationArgs,getPrices:async()=>({signed:update})});
      assert.equal(duplicate.shouldSubmit,false,'identical cached report must not request another transaction');
      const transactionCount=store.transactions().length;
      assert.deepEqual(await transactions.publish(duplicate),[]);
      assert.equal(store.transactions().length,transactionCount);
      const available=['regular','depeg','recovery'].includes(scenario);
      const readiness=await readIsolatedReadiness({client,publication:publicationArgs,confirmations:2n,now:()=>Number(clock*1000n)});
      assert.equal(readiness.available,available,`${scenario}: confirmed cache readiness`);
      assert.equal(result.readyForAdapterTrial,available,scenario);
      if(available){
        const round=await quote();assert.equal(round[1],result.quote.answer);assert.equal(round[0],result.quote.roundId);
        assert.equal(round[3],result.quote.updatedAt);
      }else await assert.rejects(quote());
      const forged=await signed(feeds,account);
      await assert.rejects(probePair({...args,getPrices:async()=>({signed:forged})}));
    }
    // Commissioning wiring against actual immutable ratio/DEX/corroboration
    // contracts. Mock pools provide addresses only; this is not price approval.
    const middle=await deploy(token,['Local intermediate','MID',18]);
    const factoryArtifact=artifact('DockyardV3TwapFeed.t.sol','IsolatedMockV3Factory');
    const factory=await deploy(factoryArtifact,[]);
    const poolArtifact=artifact('DockyardV3TwapFeed.t.sol','IsolatedMockV3Pool');
    const firstPool=await deploy(poolArtifact,[CASHCAT_PAIR.collateral,middle,factory]);
    const secondPool=await deploy(poolArtifact,[middle,CASHCAT_PAIR.usdg,factory]);
    for(const [a,b,pool] of [[CASHCAT_PAIR.collateral,middle,firstPool],[middle,CASHCAT_PAIR.usdg,secondPool]]){
      const hash=await wallet.writeContract({address:factory,abi:factoryArtifact.abi,functionName:'register',args:[a,b,pool],chain:null});
      assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');
    }
    const dex=await deploy(artifact('DockyardV3TwapFeed.sol','DockyardV3TwapFeed'),[{
      collateral:CASHCAT_PAIR.collateral,intermediate:middle,usdg:CASHCAT_PAIR.usdg,factory,firstPool,secondPool,
      window:1800,maxObservationAge:300,maxSpotTickDeviation:200,firstMinLiquidity:10n**15n,secondMinLiquidity:10n**15n,
    }]);
    const primary=await deploy(artifact('DockyardCorroboratedV3Feed.sol','DockyardCorroboratedV3Feed'),[dex,adapter,60,500]);
    const pin=async address=>keccak256(await client.getCode({address}));
    const publication=Object.fromEntries(['policy','hub','adapter','hubCodeHash','adapterCodeHash','verifierCodeHash','collateralCodeHash','usdgCodeHash'].map(k=>[k,publicationArgs[k]]));
    const guardian=privateKeyToAccount(generatePrivateKey()).address;
    const marketConfig={credit:{collateral:CASHCAT_PAIR.collateral,usdg:CASHCAT_PAIR.usdg,primary,secondary:adapter,guardian},
      intermediate:middle,firstPool,secondPool,pins:{primary:await pin(primary),secondary:await pin(adapter),collateral:publication.collateralCodeHash,
        usdg:publication.usdgCodeHash,firstPool:await pin(firstPool),secondPool:await pin(secondPool)}};
    const oracle={dex,dexCodeHash:await pin(dex),manifest:{kind:'isolated-pyth-ratio',chainId:4663,startBlock:'1',publication,
      relayAddress:account.address,guardian,keeper:privateKeyToAccount(generatePrivateKey()).address}};
    const nonce=await client.getTransactionCount({address:account.address});
    const commissioning=await verifyOracleWiring({config:marketConfig,oracle,client,blockNumber:(await client.getBlock()).number});
    assert.equal(commissioning.wiringVerified,true);assert.equal(commissioning.productionApproved,false);
    assert.equal(commissioning.relayCandidate.ORACLE_RELAY_MODE,'observe');
    assert.equal(JSON.parse(commissioning.relayCandidate.ISOLATED_ORACLE_MANIFEST_JSON).publication.adapter,adapter);
    assert.equal(await client.getTransactionCount({address:account.address}),nonce,'commissioning must not send transactions');
    console.log(JSON.stringify({evidence:'isolated-pyth-local-integration',scenarios:6,
      actualHubAndAdapter:true,durableJournalRestartEachPublication:true,receiptAndCacheValidated:true,
      actualWorkerCycles:true,watchOnlyRecoveryWithoutSigner:true,confirmedAdapterReadiness:true,
      actualOracleWiringCommissioned:true,
      localSignatureFixture:true,providerAccessVerified:false,productionChanged:false}));
  } finally {
    store?.close();rmSync(directory,{recursive:true,force:true});
    if(child.exitCode===null){
      child.kill('SIGTERM');
      await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
    }
  }
});
