import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {CASHCAT_PAIR} from '../src/isolated-pyth-preflight.mjs';
import {isolatedConfigFromEnv} from '../src/isolated-config.mjs';
import {PYTH_VERIFIER} from '../src/pyth.mjs';
import {payload,wrapPayload} from './fixtures/isolated-pyth.mjs';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
const {createPublicClient,createWalletClient,http,keccak256,toHex}=require('viem');
const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');
const artifact=(file,name)=>JSON.parse(readFileSync(new URL(`../../../contracts/out/${file}/${name}.json`,import.meta.url)));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
function childProcess(command,args,env){
  const child=spawn(command,args,{env,stdio:['ignore','pipe','pipe']});let output='';
  for(const stream of [child.stdout,child.stderr])stream.on('data',x=>{output+=x;});
  const ended=new Promise(r=>{child.once('exit',(code,signal)=>r({code,signal}));child.once('error',()=>r({code:-1}));});
  return {child,ended,output:()=>output};
}
async function stop(process,signal='SIGTERM'){
  if(process.child.exitCode!==null||process.child.signalCode!==null)return process.ended;
  process.child.kill(signal);let timer;
  try{return await Promise.race([process.ended,new Promise((_,reject)=>{timer=setTimeout(()=>{process.child.kill('SIGKILL');reject(Error('Local process shutdown timeout'));},5000);})]);}
  finally{clearTimeout(timer);}
}
async function until(check,label,timeout=20000){
  const deadline=Date.now()+timeout;while(Date.now()<deadline){const result=await check();if(result)return result;await wait(150);}
  throw Error(`Local running integration timeout: ${label}`);
}

test('actual isolated relay and watchdog processes publish, fail closed, recover and detect process death',{timeout:90000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'dockyard-oracle-running-')),children=[];
  let server;
  try{
    const rpcPort=await freePort(),port=await freePort(),rpcUrl=`http://127.0.0.1:${rpcPort}`;
    const anvil=childProcess('anvil',['--host','127.0.0.1','--port',String(rpcPort),'--chain-id','4663','--accounts','0',
      '--timestamp',String(Math.floor(Date.now()/1000)-60),'--silent'],{PATH:process.env.PATH});children.push(anvil);
    const client=createPublicClient({transport:http(rpcUrl,{timeout:2000,retryCount:0}),cacheTime:0,pollingInterval:50});
    await until(async()=>{try{return await client.getChainId()===4663;}catch{return false;}},'Anvil startup',5000);
    assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
    const key=generatePrivateKey(),account=privateKeyToAccount(key),provider=privateKeyToAccount(generatePrivateKey());
    const wallet=createWalletClient({account,transport:http(rpcUrl)});
    await client.request({method:'anvil_setBalance',params:[account.address,toHex(10n**19n)]});
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
    await client.request({method:'anvil_setCode',params:[PYTH_VERIFIER,await client.getCode({address:verifier})]});
    const hub=await deploy(artifact('DockyardPythVerifier.sol','DockyardPythVerifier'),[PYTH_VERIFIER]);
    const {collateralSymbol,usdgSymbol,...policy}=CASHCAT_PAIR;
    const adapter=await deploy(artifact('DockyardPythUsdRatioFeed.sol','DockyardPythUsdRatioFeed'),[{hub,...policy}]);
    const publication={hub,adapter,policy:CASHCAT_PAIR};
    for(const [field,address] of [['hubCodeHash',hub],['adapterCodeHash',adapter],['verifierCodeHash',PYTH_VERIFIER],
      ['collateralCodeHash',CASHCAT_PAIR.collateral],['usdgCodeHash',CASHCAT_PAIR.usdg]])publication[field]=keccak256(await client.getCode({address}));
    await client.request({method:'evm_setNextBlockTimestamp',params:[Math.floor(Date.now()/1000)]});
    await client.request({method:'evm_mine',params:[]});
    await client.request({method:'anvil_setIntervalMining',params:[1]});
    let mode='regular',emailsAvailable=true;const emails=[],errors=[],requests={symbols:0,prices:0};
    server=createServer(async(req,res)=>{
      try{
        res.setHeader('Content-Type','application/json');let body='';for await(const chunk of req)body+=chunk;
        if(req.url==='/emails'){
          assert.equal(req.headers.authorization,'Bearer local-resend-sentinel');
          emails.push({message:JSON.parse(body),accepted:emailsAvailable});res.statusCode=emailsAvailable?200:503;
          res.end(JSON.stringify({id:'local-fixture-message'}));return;
        }
        assert.equal(req.headers.authorization,'Bearer local-pyth-sentinel');
        if(req.url==='/symbols'){
          requests.symbols++;res.end(JSON.stringify([[collateralSymbol,3441,2],[usdgSymbol,232,3]].map(([symbol,id,min])=>({
            symbol,pyth_lazer_id:id,min_publishers:min,state:'stable',instrument_type:'spot',asset_type:'crypto',exponent:-8}))));return;
        }
        assert.equal(req.url,'/prices');requests.prices++;
        assert.deepEqual(JSON.parse(body).priceFeedIds,[3441,232]);
        if(mode==='denied'){res.statusCode=403;res.end('{}');return;}
        const timestamp=(await client.getBlock()).timestamp*1000000n;
        const base={timestampUs:timestamp,sourceUs:timestamp,confidence:10000n,exponent:-8,publishers:3,session:0};
        const feeds=[{...base,id:3441,price:200000000n,session:mode==='closed'?4:0},{...base,id:232,price:100000000n}];
        const data=payload(feeds),signature=Buffer.from((await provider.sign({hash:keccak256(toHex(data))})).slice(2),'hex');
        signature[64]-=27;
        res.end(JSON.stringify({evm:{encoding:'hex',data:wrapPayload(data,signature)}}));
      }catch{errors.push('fixture_request_failed');res.statusCode=500;res.end('{}');}
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const manifest={kind:'isolated-pyth-ratio',chainId:4663,startBlock:'1',publication,relayAddress:account.address,
      guardian:privateKeyToAccount(generatePrivateKey()).address,keeper:privateKeyToAccount(generatePrivateKey()).address,
      executionApproved:true,reviewDigest:'0x'+'a'.repeat(64)}; // Synthetic local authorization, not a production review.
    const env={PATH:process.env.PATH,NODE_ENV:'production',PORT:String(port),ORACLE_RPC_URL:rpcUrl,
      ORACLE_STATUS_TOKEN:'local-status-sentinel-'.repeat(3),PYTH_API_KEY:'local-pyth-sentinel',RESEND_API_KEY:'local-resend-sentinel',
      ORACLE_ALERT_EMAIL_FROM:'alerts@local.invalid',ORACLE_ALERT_EMAIL_TO:'operator@local.invalid',ORACLE_DATA_DIR:join(directory,'relay'),
      ORACLE_RELAY_MODE:'execute',ORACLE_RELAY_PRIVATE_KEY:key,ORACLE_POLL_MS:'1000',ORACLE_MAX_TX_FEE_ETH:'0.01',ORACLE_DAILY_GAS_ETH:'1',
      ISOLATED_ORACLE_MANIFEST_JSON:JSON.stringify(manifest),DOCKYARD_LOCAL_SERVICE_FIXTURE:'true',
      TEST_ORACLE_FIXTURE_URL:`http://127.0.0.1:${server.address().port}`};
    const preload=new URL('./fixtures/isolated-service-network.mjs',import.meta.url).pathname;
    const launch=entry=>{
      const childEnv={...env};
      if(entry==='isolated-watchdog'){delete childEnv.ORACLE_RELAY_PRIVATE_KEY;delete childEnv.PYTH_API_KEY;}
      const p=childProcess(process.execPath,['--import',preload,new URL(`../src/${entry}.mjs`,import.meta.url).pathname],childEnv);
      children.push(p);return p;
    };
    const statusUrl=`http://127.0.0.1:${port}/status`;
    const readStatus=async()=>{try{const r=await fetch(statusUrl,{headers:{Authorization:`Bearer ${env.ORACLE_STATUS_TOKEN}`},signal:AbortSignal.timeout(500)});return r.ok?await r.json():null;}catch{return null;}};
    let relay=launch('isolated-main');
    const ready=await until(async()=>{const s=await readStatus();return s?.ready&&s.lastPublication?s:false;},'first confirmed publication');
    assert.equal(ready.cache.available,true);assert.ok(requests.prices>0);assert.ok(emails.some(e=>e.accepted));
    env.ISOLATED_ORACLE_STATUS_URL=statusUrl;env.ISOLATED_ORACLE_EXPECTED_IDENTITY_HASH=isolatedConfigFromEnv(env,manifest).identityHash;
    env.ORACLE_WATCHDOG_DATA_DIR=join(directory,'watchdog');env.WATCHDOG_EMAIL_FROM='watchdog@local.invalid';env.WATCHDOG_EMAIL_TO='operator@local.invalid';
    const runWatchdog=async()=>{const watchdog=launch('isolated-watchdog');return (await watchdog.ended).code;};
    assert.equal(await runWatchdog(),0);
    mode='denied';emailsAvailable=false;
    await until(async()=>{const s=await readStatus();return !s?.ready&&s?.operatorAlerts?.delivered===false&&s.incidents.some(i=>i.code==='oracle_publication_failed');},'provider and email failures');
    assert.equal(await runWatchdog(),1);
    emailsAvailable=true;mode='closed';
    await until(async()=>{const s=await readStatus();return s?.cache?.available===false&&s.cache.issues?.some(i=>i.code==='non_regular_session')&&s.operatorAlerts.delivered;},'signed session invalidation');
    assert.equal(await runWatchdog(),1);
    mode='regular';await until(async()=>{const s=await readStatus();return s?.ready;},'provider recovery');
    assert.equal(await runWatchdog(),0);
    assert.equal((await stop(relay)).code,0);
    relay=launch('isolated-main');await until(async()=>{const s=await readStatus();return s?.ready&&s.lastPublication;},'same-volume process restart');
    await stop(relay,'SIGKILL');assert.equal(await runWatchdog(),1);
    assert.ok(emails.some(e=>e.accepted&&e.message.subject?.includes('watchdog_outage')));
    assert.ok(emails.some(e=>e.accepted&&e.message.subject?.includes('watchdog_recovered')));
    assert.deepEqual(errors,[]);
    for(const child of children)for(const secret of [key,env.ORACLE_STATUS_TOKEN,env.PYTH_API_KEY,env.RESEND_API_KEY])assert.ok(!child.output().includes(secret));
    console.log(JSON.stringify({evidence:'isolated-oracle-running-processes',actualRelayAndWatchdog:true,actualSignedCachePublications:true,
      providerAndEmailFailureRecovery:true,signedSessionInvalidation:true,journalRestart:true,abruptProcessDeathDetected:true,
      externalNetworkUsed:false,realProviderOrEmailDeliveryVerified:false,productionChanged:false}));
  }finally{
    for(const p of children.reverse())await stop(p).catch(()=>{});
    if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});
    rmSync(directory,{recursive:true,force:true});
  }
});
