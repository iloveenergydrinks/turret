import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {api3ConfigFromEnv} from '../../src/api3-config.mjs';
const require=createRequire(new URL('../../../liquidator/package.json',import.meta.url));
const {keccak256,encodePacked,toHex}=require('viem');
const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port;}
async function close(server){await new Promise(r=>{server.close(r);server.closeAllConnections();});}
async function freePort(){const s=createServer(),port=await listen(s);await close(s);return port;}
async function until(check,label){
  for(let i=0;i<80;i++){const result=await check();if(result)return result;await delay(100);}
  throw Error(`Local API3 process timeout: ${label}`);
}
function launch(entry,env){
  const child=spawn(process.execPath,['--import',new URL('./api3-service-network.mjs',import.meta.url).pathname,
    new URL(`../../src/${entry}.mjs`,import.meta.url).pathname],{env,stdio:['ignore','pipe','pipe']});
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',x=>{output+=x;});
  const ended=new Promise(r=>{child.once('exit',(code,signal)=>r({code,signal}));child.once('error',()=>r({code:-1}));});
  return {child,ended,output:()=>output};
}
async function stop(run,signal='SIGTERM'){
  if(run.child.exitCode!==null||run.child.signalCode!==null)return run.ended;
  run.child.kill(signal);const timer=setTimeout(()=>run.child.kill('SIGKILL'),3000);
  try{return await run.ended;}finally{clearTimeout(timer);}
}

export async function exerciseApi3Processes({client,rpcUrl,fixture,adapter,adapterCodeHash}){
  const snapshot=await client.request({method:'evm_snapshot',params:[]});
  const directory=mkdtempSync(join(tmpdir(),'dockyard-api3-running-')),runs=[],emails=[],errors=[];
  let server,providerOk=true,emailOk=true;
  try{
    const key=generatePrivateKey(),account=privateKeyToAccount(key);
    await client.request({method:'anvil_setBalance',params:[account.address,toHex(10n**19n)]});
    const epoch=Number((await client.getBlock()).timestamp)*1000,started=performance.now();
    server=createServer(async(req,res)=>{
      try{
        res.setHeader('Content-Type','application/json');let body='';for await(const chunk of req)body+=chunk;
        if(req.url==='/emails'){
          assert.equal(req.headers.authorization,'Bearer local-api3-email-sentinel');
          emails.push({message:JSON.parse(body),accepted:emailOk});res.statusCode=emailOk?200:503;
          res.end('{"id":"local-api3-message"}');return;
        }
        assert.equal(req.headers.authorization,undefined,'API3 public feeds require no credential');
        const p=fixture.packages.find(p=>req.url==='/api3/'+p.airnode);assert.ok(p);
        if(!providerOk){res.statusCode=503;res.end('{}');return;}
        res.end(JSON.stringify({data:{[keccak256(encodePacked(['address','bytes32'],[p.airnode,p.templateId]))]:p}}));
      }catch{errors.push('fixture_request_failed');res.statusCode=500;res.end('{}');}
    });
    const fixturePort=await listen(server),port=await freePort();
    const manifest={kind:'stock-api3-usdg',chainId:4663,startBlock:fixture.blockNumber,publication:{adapter,adapterCodeHash},
      relayAddress:account.address,guardian:privateKeyToAccount(generatePrivateKey()).address,
      keeper:privateKeyToAccount(generatePrivateKey()).address,executionApproved:true,reviewDigest:'0x'+'a'.repeat(64)};
    const env={PATH:process.env.PATH,NODE_ENV:'production',PORT:String(port),ORACLE_RPC_URL:rpcUrl,
      ORACLE_STATUS_TOKEN:'local-api3-status-sentinel-'.repeat(2),RESEND_API_KEY:'local-api3-email-sentinel',
      ORACLE_ALERT_EMAIL_FROM:'alerts@local.invalid',ORACLE_ALERT_EMAIL_TO:'operator@local.invalid',
      ORACLE_DATA_DIR:join(directory,'relay'),ORACLE_RELAY_MODE:'execute',ORACLE_RELAY_PRIVATE_KEY:key,
      ORACLE_POLL_MS:'1000',ORACLE_MAX_TX_FEE_ETH:'0.01',ORACLE_DAILY_GAS_ETH:'1',
      API3_ORACLE_MANIFEST_JSON:JSON.stringify(manifest),DOCKYARD_LOCAL_SERVICE_FIXTURE:'true',
      TEST_ORACLE_FIXTURE_URL:`http://127.0.0.1:${fixturePort}`};
    const start=entry=>{
      const processEnv={...env,TEST_API3_CLOCK_MS:String(epoch+Math.floor(performance.now()-started)),TEST_API3_REAL_START_MS:String(Date.now())};
      if(entry==='api3-watchdog')delete processEnv.ORACLE_RELAY_PRIVATE_KEY;
      const run=launch(entry,processEnv);runs.push(run);return run;
    };
    const url=`http://127.0.0.1:${port}/status`;
    const status=async()=>{
      try{const r=await fetch(url,{headers:{Authorization:`Bearer ${env.ORACLE_STATUS_TOKEN}`},signal:AbortSignal.timeout(500)});return r.ok?await r.json():null;}
      catch{return null;}
    };
    await client.request({method:'anvil_setIntervalMining',params:[1]});
    let relay=start('api3-main');
    const ready=await until(async()=>{const s=await status();return s?.ready&&s.lastPublication?s:null;},'confirmed publication');
    assert.equal(ready.cache.latestAvailable,true);
    env.API3_ORACLE_STATUS_URL=url;env.API3_ORACLE_EXPECTED_IDENTITY_HASH=api3ConfigFromEnv(env,manifest).identityHash;
    env.ORACLE_WATCHDOG_DATA_DIR=join(directory,'watchdog');
    env.WATCHDOG_EMAIL_FROM='watchdog@local.invalid';env.WATCHDOG_EMAIL_TO='operator@local.invalid';
    let watchdogCodes=[];
    const watchdog=async()=>{
      const run=start('api3-watchdog'),result=await run.ended;
      const records=run.output().trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
      watchdogCodes=records.find(r=>r.event==='api3_oracle_watchdog')?.codes??['no-watchdog-result'];
      return result.code;
    };
    const initialCode=await watchdog();
    assert.equal(initialCode,0,`watchdog accepts the actual healthy stock relay: ${watchdogCodes.join(',')}`);
    providerOk=false;emailOk=false;
    await until(async()=>{const s=await status();return s?.ready===false&&s.operatorAlerts.delivered===false;},'provider/email failure');
    assert.equal(await watchdog(),1);
    providerOk=true;emailOk=true;
    await until(async()=>{const s=await status();return s?.ready;},'provider/email recovery');
    assert.equal(await watchdog(),0);
    const nonce=await client.getTransactionCount({address:account.address});
    assert.equal((await stop(relay)).code,0);
    relay=start('api3-main');await until(async()=>{const s=await status();return s?.ready&&s.lastPublication;},'journal restart');
    assert.equal(await client.getTransactionCount({address:account.address}),nonce,'restart must not republish unchanged prices');
    await stop(relay,'SIGKILL');assert.equal(await watchdog(),1,'watchdog sees process death');
    const count=emails.length;
    assert.equal(await watchdog(),1);assert.equal(emails.length,count,'separate watchdog restarts preserve outage deduplication');
    assert.ok(emails.some(e=>e.accepted&&e.message.subject?.includes('api3_oracle_watchdog_outage')));
    assert.ok(emails.some(e=>e.accepted&&e.message.subject?.includes('api3_oracle_watchdog_recovered')));
    assert.deepEqual(errors,[]);
    for(const run of runs)for(const secret of [key,env.ORACLE_STATUS_TOKEN,env.RESEND_API_KEY])assert.ok(!run.output().includes(secret));
    console.log(JSON.stringify({evidence:'api3-native-fork-running-processes',actualRelayAndWatchdog:true,
      realPublicSignatures:true,providerAndEmailFailureRecovery:true,journalRestart:true,processDeathDetected:true,
      realEmailDeliveryVerified:false,productionChanged:false}));
  }finally{
    for(const run of runs.reverse())await stop(run);
    if(server)await close(server);
    await client.request({method:'anvil_setIntervalMining',params:[0]});
    await client.request({method:'evm_setAutomine',params:[true]});
    await client.request({method:'evm_revert',params:[snapshot]});
    rmSync(directory,{recursive:true,force:true});
  }
}
