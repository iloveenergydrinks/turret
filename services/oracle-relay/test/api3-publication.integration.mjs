import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {prepareApi3UsdgPublication} from '../src/api3-usdg.mjs';
import {Api3UsdgTransactions} from '../src/api3-transactions.mjs';
import {Store} from '../../liquidator/src/store.mjs';
import {readApi3UsdgReadiness} from '../src/api3-readiness.mjs';
import {api3ConfigFromEnv} from '../src/api3-config.mjs';
import {Api3UsdgWorker} from '../src/api3-worker.mjs';
import {Chain} from '../../liquidator/src/chain.mjs';
import {Alerts} from '../../liquidator/src/alerts.mjs';
import {exerciseApi3Processes} from './fixtures/api3-running.mjs';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
const {createPublicClient,createWalletClient,http,keccak256,toHex,decodeFunctionData}=require('viem');
const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');
const fixture=JSON.parse(readFileSync(new URL('../../../contracts/utils/assets/oracle-fixtures/api3-usdg-fork.json',import.meta.url)));
const artifact=JSON.parse(readFileSync(new URL('../../../contracts/out/DockyardApi3UsdgFeed.sol/DockyardApi3UsdgFeed.json',import.meta.url)));

// Public historical signatures and native verifier state. Transaction signing is
// confined to a disposable loopback Anvil node with a generated account.
test('native API3 publication plan updates the deployed adapter and skips an already-current cache',{timeout:120000},async t=>{
  // Keep an optional archive credential out of Anvil arguments and diagnostics.
  // The upstream proxy permits reads only; local writes cannot escape the fork.
  const upstream=process.env.API3_TEST_FORK_RPC_URL??'https://rpc.mainnet.chain.robinhood.com';
  const allowed=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash',
    'eth_getCode','eth_getStorageAt','eth_getBalance','eth_getTransactionCount','eth_getTransactionByHash',
    'eth_getTransactionReceipt','eth_getProof','net_version']);
  const proxy=createHttpServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    let id=null;
    try{
      let body='';for await(const part of req){body+=part;if(body.length>1048576)throw Error('RPC request too large');}
      const request=JSON.parse(body);id=request.id;
      if(!allowed.has(request.method))throw Error('Fork upstream write refused');
      const response=await fetch(upstream,{method:'POST',headers:{'Content-Type':'application/json'},body,
        redirect:'error',signal:AbortSignal.timeout(15000)});
      const result=await response.json();if(!response.ok||result.error)throw Error('Fork source RPC failure');
      res.end(JSON.stringify(result));
    }catch{res.end(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000,message:'Read-only fork source unavailable'}}));}
  });
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>{proxy.close(r);proxy.closeAllConnections();});});
  const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
  const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--accounts','0','--silent',
    '--fork-url',`http://127.0.0.1:${proxy.address().port}`,'--fork-block-number',fixture.blockNumber],{stdio:'ignore'});
  let startupError;child.on('error',error=>{startupError=error;});
  t.after(async()=>{if(!startupError&&child.exitCode===null){const done=new Promise(r=>child.once('close',r));child.kill('SIGTERM');await done;}});
  const transport=http(`http://127.0.0.1:${port}`,{timeout:10000,retryCount:0});
  const client=createPublicClient({transport,cacheTime:0,pollingInterval:20});
  let ready=false;
  for(let i=0;i<200;i++){
    if(startupError||child.exitCode!==null)throw Error('Disposable API3 fork failed');
    try{if(await client.getChainId()===4663){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(ready);assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
  assert.equal((await client.getBlock({blockNumber:BigInt(fixture.blockNumber)})).hash,fixture.blockHash);
  assert.equal(keccak256(await client.getCode({address:fixture.server})),fixture.serverCodeHash);
  const account=privateKeyToAccount(generatePrivateKey());
  await client.request({method:'anvil_setBalance',params:[account.address,toHex(10n**20n)]});
  const wallet=createWalletClient({account,transport});
  const hash=await wallet.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,args:[fixture.server,fixture.serverCodeHash],chain:null});
  const deployed=await client.waitForTransactionReceipt({hash});assert.equal(deployed.status,'success');
  const adapter=deployed.contractAddress,adapterCodeHash=keccak256(await client.getCode({address:adapter}));
  await client.request({method:'evm_mine',params:[]});
  await client.request({method:'evm_mine',params:[]});
  const fetcher=async url=>{
    const p=fixture.packages.find(p=>url.endsWith(p.airnode));assert.ok(p);
    const id=keccak256(require('viem').encodePacked(['address','bytes32'],[p.airnode,p.templateId]));
    return {ok:true,json:async()=>({data:{[id]:p}})};
  };
  const head=await client.getBlock(),now=()=>Number(head.timestamp)*1000;
  const args={client,adapter,adapterCodeHash,fetcher,now};
  const readinessArgs={client,publication:{adapter,adapterCodeHash},confirmations:2n,now};
  assert.equal((await readApi3UsdgReadiness(readinessArgs)).available,false,'unpublished cache is not ready');
  const workerSnapshot=await client.request({method:'evm_snapshot',params:[]});
  const before=await client.getBlockNumber({cacheTime:0});
  const plan=await prepareApi3UsdgPublication(args);
  assert.equal(await client.getBlockNumber({cacheTime:0}),before,'preparation must not broadcast');
  assert.equal(plan.shouldSubmit,true);assert.equal(plan.updateCount,5);
  assert.equal(plan.to,fixture.server);assert.equal(plan.value,0n);
  assert.equal(plan.adapter,adapter);assert.equal(plan.productionApproved,false);
  assert.equal(plan.expiresAt,BigInt(fixture.expectedOldest)+60n);
  const decoded=decodeFunctionData({abi:require('viem').parseAbi(['function multicall(bytes[]) returns(bytes[])']),data:plan.data});
  assert.equal(decoded.functionName,'multicall');assert.equal(decoded.args[0].length,5);
  await t.test('actual stock API3 relay and independent watchdog processes recover and detect process death',async()=>{
    await exerciseApi3Processes({client,rpcUrl:`http://127.0.0.1:${port}`,fixture,adapter,adapterCodeHash});
  });
  await t.test('a valid zero-priority-fee publication remains broadcastable after signing',async()=>{
    const snapshot=await client.request({method:'evm_snapshot',params:[]});
    const relay=privateKeyToAccount(generatePrivateKey());
    await client.request({method:'anvil_setBalance',params:[relay.address,toHex(10n**20n)]});
    const journal=new Store(':memory:',{kind:'api3-zero-tip-test',relay:relay.address});journal.acquireLease();
    const config={chainId:4663,mode:'execute',publication:{adapter,adapterCodeHash},confirmations:2n,
      minEth:0n,maxTxFee:10n**18n,maxDailyGas:10n**19n,replaceAfterMs:60000,maxReplacements:2};
    const zeroTipTransport=require('viem').custom({request:a=>a.method==='eth_maxPriorityFeePerGas'?Promise.resolve('0x0'):client.request(a)});
    const chain={client,account:relay,wallet:createWalletClient({account:relay,transport:zeroTipTransport}),consistent:true};
    try{
      const txs=new Api3UsdgTransactions(chain,journal,config,{now});
      const notices=await txs.publish(plan);
      assert.equal(journal.pendingTx().request.maxPriorityFeePerGas,0n);
      assert.deepEqual(notices,[]);
      assert.equal((await client.waitForTransactionReceipt({hash:journal.pendingTx().attempts[0].hash})).status,'success');
    }finally{journal.close();await client.request({method:'evm_revert',params:[snapshot]});}
  });
  await t.test('an expired uncertain publication frees its nonce with a bounded durable self-cancellation',async()=>{
    const snapshot=await client.request({method:'evm_snapshot',params:[]});
    const key=generatePrivateKey(),relay=privateKeyToAccount(key);
    await client.request({method:'anvil_setBalance',params:[relay.address,toHex(10n**20n)]});
    const directory=mkdtempSync(join(tmpdir(),'dockyard-api3-cancel-'));
    const identity={kind:'api3-cancel-test',relay:relay.address};
    let journal=new Store(directory,identity);journal.acquireLease();
    let clock=Number((await client.getBlock()).timestamp)*1000,send=false;
    const config={chainId:4663,mode:'execute',publication:{adapter,adapterCodeHash},confirmations:2n,
      minEth:0n,maxTxFee:10n**18n,maxDailyGas:10n**19n,replaceAfterMs:60000,maxReplacements:2};
    const chain={account:relay,wallet:createWalletClient({account:relay,transport}),consistent:true,
      client:{...client,sendRawTransaction:async a=>{
        assert.equal(journal.pendingTx().attempts.at(-1).raw,a.serializedTransaction,'journal precedes broadcast');
        if(!send)throw Error('Local submission timeout');
        return client.sendRawTransaction(a);
      }}};
    try{
      let txs=new Api3UsdgTransactions(chain,journal,config,{now:()=>clock});
      assert.equal((await txs.publish(plan))[0].code,'broadcast_uncertain');
      const original=journal.pendingTx().attempts[0].hash;
      clock=Number(plan.expiresAt)*1000;
      await client.request({method:'evm_setNextBlockTimestamp',params:[Number(plan.expiresAt)]});
      await client.request({method:'evm_mine',params:[]});
      const watch=new Api3UsdgTransactions({...chain,account:{address:relay.address}},journal,{...config,mode:'observe'},{now:()=>clock});
      await watch.recover(await client.getBlock(),true);
      assert.equal(journal.pendingTx().attempts.length,1,'observe mode cannot cancel');
      const limited=new Api3UsdgTransactions(chain,journal,{...config,maxTxFee:0n},{now:()=>clock});
      await limited.recover(await client.getBlock(),true);
      assert.equal(journal.pendingTx().attempts.length,1,'gas ceiling prevents cancellation signing');
      await txs.recover(await client.getBlock(),true);
      const tracked=journal.pendingTx();
      assert.equal(tracked.attempts.length,2,'obsolete update must acquire a cancellation attempt');
      assert.equal(tracked.attempts[0].hash,original,'original receipt must remain reconcilable');
      const cancellation=tracked.attempts[1];
      assert.equal((await limited.recover(await client.getBlock(),true))[0].details.reason,'Api3RecoveryGasBudget',
        'previously signed cancellation still respects the current gas limit before rebroadcast');
      const parsed=require('viem').parseTransaction(cancellation.raw);
      assert.equal(parsed.to.toLowerCase(),relay.address.toLowerCase());
      assert.equal(parsed.nonce??0,0);assert.equal(parsed.value??0n,0n);assert.equal(parsed.data??'0x','0x');
      assert.equal(parsed.chainId,4663);
      journal.close();journal=new Store(directory,identity);journal.acquireLease();
      txs=new Api3UsdgTransactions(chain,journal,config,{now:()=>clock});send=true;
      await txs.recover(await client.getBlock(),true);
      const receipt=await client.waitForTransactionReceipt({hash:cancellation.hash});
      assert.equal(receipt.status,'success');
      await txs.recover(await client.getBlock(),true);
      assert.ok(journal.pendingTx(),'receipt must wait for confirmation depth');
      assert.equal(journal.pendingTx().attempts.length,2,'restart rebroadcasts the same cancellation');
      await client.request({method:'evm_mine',params:[]});await client.request({method:'evm_mine',params:[]});
      await txs.recover(await client.getBlock(),true);
      assert.equal(journal.pendingTx(),undefined);
      const final=journal.transactions()[0];
      assert.equal(final.kind,'api3_usdg_cancel');assert.equal(final.status,'confirmed');
      assert.ok(!final.publicationResult,'cancellation is not an oracle publication');
      assert.equal(final.receipt.hash,cancellation.hash);
      assert.equal(final.finalizedAt,clock);
      assert.equal(await client.getTransactionCount({address:relay.address}),1);
      assert.equal((await readApi3UsdgReadiness({...readinessArgs,now:()=>clock})).available,false);
    }finally{journal.close();rmSync(directory,{recursive:true,force:true});await client.request({method:'evm_revert',params:[snapshot]});}
  });
  await t.test('superseded updates cancel, while an original transaction winning the race is still reconciled',async()=>{
    for(const winner of ['superseded','original']){
      const snapshot=await client.request({method:'evm_snapshot',params:[]});
      const relay=privateKeyToAccount(generatePrivateKey());
      await client.request({method:'anvil_setBalance',params:[relay.address,toHex(10n**20n)]});
      const journal=new Store(':memory:',{kind:'api3-race-test',relay:relay.address});journal.acquireLease();
      let clock=Number((await client.getBlock()).timestamp)*1000;
      const config={chainId:4663,mode:'execute',publication:{adapter,adapterCodeHash},confirmations:2n,
        minEth:0n,maxTxFee:10n**18n,maxDailyGas:10n**19n,replaceAfterMs:1000,maxReplacements:1};
      const chain={account:relay,wallet:createWalletClient({account:relay,transport}),consistent:true,
        client:{...client,sendRawTransaction:async()=>{throw Error('Local submission timeout');}}};
      try{
        const txs=new Api3UsdgTransactions(chain,journal,config,{now:()=>clock});
        await txs.publish(plan);const original=journal.pendingTx().attempts[0];
        if(winner==='superseded'){
          await client.waitForTransactionReceipt({hash:await wallet.sendTransaction({to:plan.to,data:decoded.args[0][0],value:0n,chain:null})});
        }else{
          clock=Number(plan.expiresAt)*1000;
          await client.request({method:'evm_setNextBlockTimestamp',params:[Number(plan.expiresAt)]});
          await client.request({method:'evm_mine',params:[]});
        }
        await txs.recover(await client.getBlock(),true);
        const pending=journal.pendingTx();assert.equal(pending.attempts.length,2);
        assert.equal(pending.cancellation.reason,winner==='superseded'?'superseded':'expired');
        const chosen=winner==='original'?original:pending.attempts[1];
        await client.waitForTransactionReceipt({hash:await client.sendRawTransaction({serializedTransaction:chosen.raw})});
        await txs.recover(await client.getBlock(),true);
        assert.equal(journal.pendingTx().attempts.length,2,'no cancellation replacement while a known receipt awaits depth');
        await client.request({method:'evm_mine',params:[]});await client.request({method:'evm_mine',params:[]});
        await txs.recover(await client.getBlock(),true);
        assert.equal(journal.pendingTx(),undefined);
        const final=journal.transactions()[0];assert.equal(final.receipt.hash,chosen.hash);
        assert.equal(final.kind,winner==='original'?'api3_usdg_update':'api3_usdg_cancel');
        assert.equal(final.publicationResult?.updatedBeaconIds.length,winner==='original'?5:undefined);
      }finally{journal.close();await client.request({method:'evm_revert',params:[snapshot]});}
    }
  });
  await t.test('cancellation stays bounded across long outages, changed account code, reorgs and unknown nonce consumption',async()=>{
    const snapshot=await client.request({method:'evm_snapshot',params:[]});
    const relay=privateKeyToAccount(generatePrivateKey());
    await client.request({method:'anvil_setBalance',params:[relay.address,toHex(10n**20n)]});
    const journal=new Store(':memory:',{kind:'api3-bounds-test',relay:relay.address});journal.acquireLease();
    let clock=Number((await client.getBlock()).timestamp)*1000;
    const config={chainId:4663,mode:'execute',publication:{adapter,adapterCodeHash},confirmations:2n,
      minEth:0n,maxTxFee:10n**18n,maxDailyGas:10n**19n,replaceAfterMs:1000,maxReplacements:1};
    const chain={account:relay,wallet:createWalletClient({account:relay,transport}),consistent:true,
      client:{...client,sendRawTransaction:async()=>{throw Error('Local submission timeout');}}};
    const realNow=Date.now;
    try{
      Date.now=()=>clock;
      const txs=new Api3UsdgTransactions(chain,journal,config,{now:()=>clock});
      await txs.publish(plan);
      clock+=25*3600000;
      journal.acquireLease(); // Simulate a restarted owner after the long outage.
      await client.request({method:'evm_setNextBlockTimestamp',params:[clock/1000]});await client.request({method:'evm_mine',params:[]});
      const budget=await new Api3UsdgTransactions(chain,journal,{...config,maxDailyGas:1n},{now:()=>clock}).recover(await client.getBlock(),true);
      assert.equal(budget[0].details.reason,'Api3RecoveryGasBudget');
      assert.equal(journal.pendingTx().attempts.length,1,'old pending reserve cannot produce a negative daily gas charge');
      chain.consistent=false;await txs.recover(await client.getBlock(),true);chain.consistent=true;
      assert.equal(journal.pendingTx().attempts.length,1,'RPC disagreement prevents cancellation');
      await client.request({method:'anvil_setCode',params:[relay.address,'0x00']});
      assert.equal((await txs.recover(await client.getBlock(),true))[0].details.reason,'Api3CancellationRecipientHasCode');
      assert.equal(journal.pendingTx().attempts.length,1,'self recipient must be an EOA without delegated code');
      await client.request({method:'anvil_setCode',params:[relay.address,'0x']});
      await client.request({method:'evm_mine',params:[]});
      const reorg={...chain,client:{...chain.client,getBlock:async a=>{
        const block=await client.getBlock(a);return a?.blockNumber?{...block,hash:'0x'+'11'.repeat(32)}:block;
      }}};
      assert.equal((await new Api3UsdgTransactions(reorg,journal,config,{now:()=>clock}).recover(await client.getBlock(),true))[0].details.reason,'Api3CancellationReorg');
      assert.equal(journal.pendingTx().attempts.length,1,'changed canonical head prevents cancellation');
      const recovered=await txs.recover(await client.getBlock(),true);
      assert.equal(journal.pendingTx().attempts.length,2,JSON.stringify(recovered));
      clock+=2000;
      await txs.recover(await client.getBlock(),true);
      assert.equal(journal.pendingTx().attempts.length,3);
      const attempts=journal.pendingTx().attempts;
      assert.ok(require('viem').parseTransaction(attempts[2].raw).maxFeePerGas>require('viem').parseTransaction(attempts[1].raw).maxFeePerGas);
      clock+=2000;
      assert.equal((await txs.recover(await client.getBlock(),true))[0].code,'api3_cancellation_stuck');
      assert.equal(journal.pendingTx().attempts.length,3,'replacement limit never discards tracked hashes');
      await client.request({method:'anvil_setNonce',params:[relay.address,'0x1']});
      assert.equal((await txs.recover(await client.getBlock(),true))[0].code,'nonce_consumed');
      assert.equal(journal.pendingTx().status,'blocked');
    }finally{Date.now=realNow;journal.close();await client.request({method:'evm_revert',params:[snapshot]});}
  });
  await t.test('changed adapter runtime, server binding, beacon identity and policy are rejected',async()=>{
    await assert.rejects(prepareApi3UsdgPublication({...args,adapterCodeHash:'0x'+'11'.repeat(32)}),/AdapterRuntimeChanged/);
    for(const [name,value,reason] of [['server',account.address,/BindingMismatch/],
      ['serverCodeHash','0x'+'11'.repeat(32),/BindingMismatch/],
      ['beaconId','0x'+'11'.repeat(32),/BeaconMismatch/],['MAX_AGE',3600,/PolicyMismatch/]]){
      const broken={...client,readContract:a=>a.address===adapter&&a.functionName===name?Promise.resolve(value):client.readContract(a)};
      await assert.rejects(prepareApi3UsdgPublication({...args,client:broken}),reason);
    }
  });
  await t.test('canonical block change prevents a publication plan',async()=>{
    const reorg={...client,getBlock:async a=>{const b=await client.getBlock(a);return a?.blockNumber?{...b,hash:'0x'+'11'.repeat(32)}:b;}};
    await assert.rejects(prepareApi3UsdgPublication({...args,client:reorg}),/SnapshotChanged/);
  });
  await t.test('provider data that expires during simulation never becomes an executable intent',async()=>{
    let clock=head.timestamp;
    const slow={...client,simulateContract:async a=>{
      const r=await client.simulateContract(a);clock=BigInt(fixture.expectedOldest)+60n;return r;
    }};
    await assert.rejects(prepareApi3UsdgPublication({...args,client:slow,now:()=>Number(clock)*1000}),/PublicationExpired/);
  });
  // Another permissionless publisher wins one beacon between polling cycles.
  // Prepare again instead of signing the now-obsolete five-update intent.
  const first=await client.waitForTransactionReceipt({hash:await wallet.sendTransaction({to:plan.to,data:decoded.args[0][0],value:0n,chain:null})});
  assert.equal(first.status,'success');
  const mixed=await prepareApi3UsdgPublication(args);
  assert.equal(mixed.shouldSubmit,true);assert.equal(mixed.updateCount,4);
  const directory=mkdtempSync(join(tmpdir(),'dockyard-api3-journal-'));
  let store;
  t.after(()=>{store?.close();rmSync(directory,{recursive:true,force:true});});
  const relay=privateKeyToAccount(generatePrivateKey());
  await client.request({method:'anvil_setBalance',params:[relay.address,toHex(10n**20n)]});
  const relayWallet=createWalletClient({account:relay,transport});
  const identity={kind:'api3-usdg-test',adapter,adapterCodeHash,relay:relay.address};
  store=new Store(directory,identity);store.acquireLease();
  const config={chainId:4663,mode:'execute',publication:{adapter,adapterCodeHash},confirmations:2n,
    minEth:0n,maxTxFee:10n**18n,maxDailyGas:10n**19n,replaceAfterMs:60000,maxReplacements:2};
  let uncertain=true;
  const chain={account:relay,wallet:relayWallet,consistent:true,client:{...client,sendRawTransaction:async a=>{
    assert.ok(store.pendingTx(),'signed intent must be durable before any submission');
    if(uncertain){uncertain=false;throw Error('Simulated submission timeout');}
    return client.sendRawTransaction(a);
  }}};
  await t.test('observe mode and gas limits cannot sign or create an intent',async()=>{
    const noSigner={...chain,account:{address:relay.address,signTransaction:()=>assert.fail('Signing forbidden')}};
    assert.deepEqual(await new Api3UsdgTransactions(noSigner,store,{...config,mode:'observe'},{now}).publish(mixed),[]);
    const notices=await new Api3UsdgTransactions(noSigner,store,{...config,maxTxFee:0n},{now}).publish(mixed);
    assert.equal(notices[0].code,'gas_budget');assert.equal(store.transactions().length,0);
    assert.equal(await client.getTransactionCount({address:relay.address}),0);
  });
  await t.test('adapter changes after planning are rejected before signing',async()=>{
    const changed={...chain,account:{address:relay.address,signTransaction:()=>assert.fail('Signing forbidden')},
      client:{...chain.client,readContract:a=>a.address===adapter&&a.functionName==='MAX_AGE'?Promise.resolve(3600):client.readContract(a)}};
    await assert.rejects(new Api3UsdgTransactions(changed,store,config,{now}).publish(mixed),/PolicyMismatch/);
    assert.equal(store.transactions().length,0);
  });
  let txs=new Api3UsdgTransactions(chain,store,config,{now});
  const notices=await txs.publish(mixed);
  assert.equal(notices[0].code,'broadcast_uncertain',JSON.stringify(notices));
  const pending=store.pendingTx();assert.equal(pending.kind,'api3_usdg_update');
  assert.equal(pending.attempts.length,1);assert.equal(pending.request.nonce,0);
  await t.test('fee replacements cannot change the signed publication or nonce',async()=>{
    await assert.rejects(txs.makeAttempt({...pending.request,nonce:1}),/ChangedApi3ReplacementIntent/);
    await assert.rejects(txs.makeAttempt({...pending.request,data:plan.data}),/ChangedApi3ReplacementIntent/);
    assert.equal(store.pendingTx().attempts.length,1);
  });
  const pendingHash=pending.attempts[0].hash;
  store.close();store=new Store(directory,identity);store.acquireLease();
  const observe=new Api3UsdgTransactions({...chain,account:{address:relay.address}},store,{...config,mode:'observe'},{now});
  assert.equal((await observe.recover(await client.getBlock(),false))[0].code,'pending_execution_blocked');
  assert.equal(await client.getTransactionCount({address:relay.address}),0);
  txs=new Api3UsdgTransactions(chain,store,config,{now});
  assert.deepEqual(await txs.recover(await client.getBlock(),true),[]);
  const receipt=await client.waitForTransactionReceipt({hash:pendingHash});
  assert.equal(receipt.status,'success');
  assert.equal((await readApi3UsdgReadiness(readinessArgs)).available,false,'an unconfirmed update is not ready');
  await client.request({method:'evm_mine',params:[]});
  await client.request({method:'evm_mine',params:[]});
  // A watch-only restart can verify confirmation without loading a signer.
  store.close();store=new Store(directory,identity);store.acquireLease();
  txs=new Api3UsdgTransactions({...chain,account:{address:relay.address}},store,{...config,mode:'observe'},{now});
  assert.deepEqual(await txs.recover(await client.getBlock(),false),[]);
  assert.equal(store.pendingTx(),undefined);
  const confirmed=store.transactions()[0];assert.equal(confirmed.status,'confirmed');
  assert.equal(confirmed.attempts.length,1);assert.equal(confirmed.publicationResult.updatedBeaconIds.length,4);
  const readiness=await readApi3UsdgReadiness(readinessArgs);
  assert.equal(readiness.available,true);assert.equal(readiness.quote.medianPrice18,BigInt(fixture.expectedMedian));
  await t.test('an accepted slightly future head cannot extend readiness beyond the watchdog freshness window',async()=>{
    const head=await client.getBlock(),wall=Number(head.timestamp-1n)*1000;
    const state=await readApi3UsdgReadiness({...readinessArgs,now:()=>wall});
    assert.equal(state.available,true);
    assert.ok(state.validUntil<=state.checkedAt+30000,'readiness must fit the independent watchdog 30-second window');
  });
  assert.equal(readiness.block,receipt.blockNumber);
  assert.equal(readiness.productionApproved,false);
  assert.ok(readiness.validUntil<=Number(BigInt(fixture.expectedOldest)+60n)*1000);
  await t.test('a valid confirmed price cannot hide invalid latest beacon state',async()=>{
    const latest=await client.getBlock();
    const invalidLatest={...client,readContract:a=>a.blockNumber===latest.number&&a.functionName==='dataFeeds'
      ?Promise.resolve([0n,Number(latest.timestamp)]):client.readContract(a)};
    const r=await readApi3UsdgReadiness({...readinessArgs,client:invalidLatest});
    assert.equal(r.available,false);
  });
  const round=await client.readContract({address:adapter,abi:artifact.abi,functionName:'latestRoundData'});
  assert.equal(round[1],BigInt(fixture.expectedMedian));assert.equal(round[3],BigInt(fixture.expectedOldest));
  const again=await prepareApi3UsdgPublication(args);
  assert.equal(again.shouldSubmit,false);assert.equal(again.updateCount,0);assert.equal(again.data,null);
  await client.request({method:'evm_setNextBlockTimestamp',params:[Number(BigInt(fixture.expectedOldest)+60n)]});
  await client.request({method:'evm_mine',params:[]});
  await assert.rejects(prepareApi3UsdgPublication({...args,now:()=>Number(BigInt(fixture.expectedOldest)+60n)*1000}),/PriceOrTimestampInvalid/);
  await assert.rejects(client.readContract({address:adapter,abi:artifact.abi,functionName:'latestRoundData'}));
  const expired=await readApi3UsdgReadiness({...readinessArgs,now:()=>Number(BigInt(fixture.expectedOldest)+60n)*1000});
  assert.equal(expired.available,false,'a historically valid quote is not ready after expiry');
  await t.test('actual API3 worker publishes, waits for confirmation, alerts on outages and recovers',async()=>{
    // Independent scenario on the same disposable fork. Only time and external
    // provider/email HTTP boundaries are substituted; worker, chain, journal,
    // transaction manager, signature verification and native server are real.
    assert.equal(await client.request({method:'evm_revert',params:[workerSnapshot]}),true);
    const outageSnapshot=await client.request({method:'evm_snapshot',params:[]});
    const key=generatePrivateKey(),workerAccount=privateKeyToAccount(key);
    await client.request({method:'anvil_setBalance',params:[workerAccount.address,toHex(10n**20n)]});
    const manifest={kind:'stock-api3-usdg',chainId:4663,startBlock:fixture.blockNumber,publication:{adapter,adapterCodeHash},
      relayAddress:workerAccount.address,guardian:privateKeyToAccount(generatePrivateKey()).address,
      keeper:privateKeyToAccount(generatePrivateKey()).address,executionApproved:true,reviewDigest:'0x'+'a'.repeat(64)};
    const config=api3ConfigFromEnv({ORACLE_RPC_URL:`http://127.0.0.1:${port}`,ORACLE_STATUS_TOKEN:'local-worker-status-'.repeat(3),
      ORACLE_RELAY_MODE:'execute',ORACLE_RELAY_PRIVATE_KEY:key,ORACLE_MAX_TX_FEE_ETH:'0.01',ORACLE_DAILY_GAS_ETH:'1',
      RESEND_API_KEY:'local-email-sentinel',ORACLE_ALERT_EMAIL_FROM:'alerts@local.invalid',ORACLE_ALERT_EMAIL_TO:'ops@local.invalid'},manifest);
    let clock=Number((await client.getBlock()).timestamp)*1000,providerOk=true,emailOk=true,emailCount=0;
    const realNow=Date.now,realFetch=globalThis.fetch;let workerStore;
    try{
      Date.now=()=>clock;
      globalThis.fetch=async(input,options)=>{
        const url=String(input);
        if(url.startsWith('https://signed-api.api3.org/public/')){
          if(!providerOk)return new Response('{}',{status:503});
          const p=await fetcher(url);return new Response(JSON.stringify(await p.json()),{status:200});
        }
        if(url==='https://api.resend.com/emails'){
          assert.equal(options.headers.Authorization,'Bearer local-email-sentinel');emailCount++;
          return new Response('{"id":"local-message"}',{status:emailOk?200:503});
        }
        return realFetch(input,options);
      };
      workerStore=new Store(':memory:',config.identity);workerStore.acquireLease();
      const chain=new Chain(config),txs=new Api3UsdgTransactions(chain,workerStore,config);
      const worker=new Api3UsdgWorker({chain,store:workerStore,txs,alerts:new Alerts(workerStore,config),config});
      const first=await worker.cycle();assert.equal(first.kind,'stock-api3-usdg');assert.equal(first.ready,false);
      assert.equal(workerStore.pendingTx().kind,'api3_usdg_update');
      await client.request({method:'evm_mine',params:[]});await client.request({method:'evm_mine',params:[]});
      const ready=await worker.cycle();assert.equal(ready.ready,true);assert.ok(ready.lastPublication);
      assert.equal(workerStore.transactions().length,1);assert.equal(ready.cache.available,true);
      assert.ok(emailCount>0);assert.equal(ready.operatorAlerts.delivered,true);
      providerOk=false;emailOk=false;clock+=1000;
      const outage=await worker.cycle();assert.equal(outage.ready,false);assert.equal(outage.operatorAlerts.delivered,false);
      assert.ok(outage.incidents.some(i=>i.code==='oracle_publication_failed'));
      providerOk=true;emailOk=true;clock+=1000;
      const recovered=await worker.cycle();assert.equal(recovered.ready,true);assert.equal(recovered.operatorAlerts.delivered,true);
      assert.equal(workerStore.transactions().length,1,'current beacons must not trigger another transaction');
      assert.ok(!JSON.stringify(recovered,(_,v)=>typeof v==='bigint'?String(v):v).includes(key));
      clock=recovered.cache.validUntil;assert.equal(worker.health().ready,false,'health expires without another poll');
      // Re-run through the real worker with an uncertain send followed by a
      // provider outage. Recovery cannot depend on fetching a fresh report.
      assert.equal(await client.request({method:'evm_revert',params:[outageSnapshot]}),true);
      workerStore.close();workerStore=undefined;
      const outageKey=generatePrivateKey(),outageAccount=privateKeyToAccount(outageKey);
      await client.request({method:'anvil_setBalance',params:[outageAccount.address,toHex(10n**20n)]});
      const outageConfig=api3ConfigFromEnv({ORACLE_RPC_URL:`http://127.0.0.1:${port}`,ORACLE_STATUS_TOKEN:'outage-status-'.repeat(4),
        ORACLE_RELAY_MODE:'execute',ORACLE_RELAY_PRIVATE_KEY:outageKey,ORACLE_MAX_TX_FEE_ETH:'0.01',ORACLE_DAILY_GAS_ETH:'1',
        RESEND_API_KEY:'local-email-sentinel',ORACLE_ALERT_EMAIL_FROM:'alerts@local.invalid',ORACLE_ALERT_EMAIL_TO:'ops@local.invalid'},
        {...manifest,relayAddress:outageAccount.address});
      clock=Number((await client.getBlock()).timestamp)*1000;providerOk=true;emailOk=true;
      let allowSend=false;
      const providerFetch=globalThis.fetch;
      globalThis.fetch=async(input,options)=>{
        const requestBody=options?.body??(input instanceof Request?await input.clone().text():undefined);
        if(requestBody&&JSON.parse(requestBody).method==='eth_sendRawTransaction'&&!allowSend)
          return new Response(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(requestBody).id,error:{code:-32000,message:'Local submission unavailable'}}));
        return providerFetch(input,options);
      };
      workerStore=new Store(':memory:',outageConfig.identity);workerStore.acquireLease();
      const outageChain=new Chain(outageConfig),outageTxs=new Api3UsdgTransactions(outageChain,workerStore,outageConfig);
      const outageWorker=new Api3UsdgWorker({chain:outageChain,store:workerStore,txs:outageTxs,alerts:new Alerts(workerStore,outageConfig),config:outageConfig});
      await outageWorker.cycle();assert.equal(workerStore.pendingTx().attempts.length,1);
      providerOk=false;allowSend=true;clock=Number(plan.expiresAt)*1000;
      await client.request({method:'evm_setNextBlockTimestamp',params:[Number(plan.expiresAt)]});
      await client.request({method:'evm_mine',params:[]});
      const unavailable=await outageWorker.cycle();
      assert.equal(unavailable.ready,false);assert.ok(unavailable.incidents.some(i=>i.code==='oracle_publication_failed'));
      assert.equal(workerStore.pendingTx().attempts.length,2,'provider failure must not strand an expired nonce');
      await client.request({method:'evm_mine',params:[]});await client.request({method:'evm_mine',params:[]});
      const cleaned=await outageWorker.cycle();
      assert.equal(workerStore.pendingTx(),undefined);assert.equal(cleaned.lastPublication,null);
      assert.equal(workerStore.transactions()[0].kind,'api3_usdg_cancel');assert.equal(cleaned.ready,false);
    }finally{workerStore?.close();Date.now=realNow;globalThis.fetch=realFetch;}
  });
});
