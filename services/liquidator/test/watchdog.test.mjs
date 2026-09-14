import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';

test('worker-reported liveness failure is not a deployment mismatch or duplicate watchdog email',async()=>{
 const address=n=>'0x'+String(n).padStart(40,'0'),hash='0x'+'ab'.repeat(32),messages=[];let reject=false;
 const snapshot={marketKind:'stock',chainId:4663,mode:'execute',reconciled:true,head:'123',engine:address(1),pool:address(2),
  executionGate:address(3),collateral:address(4),account:address(5),codeHash:hash,poolCodeHash:hash,
  incidents:[{code:'execution_liveness_unavailable',severity:'critical'}]};
 const server=createServer(async(req,res)=>{
  if(req.url==='/status')res.end(JSON.stringify({alive:true,operational:false,lastError:null,alertDelivery:{delivered:true},snapshot:{...snapshot,checkedAt:Date.now()}}));
  else {let body='';for await(const chunk of req)body+=chunk;messages.push(JSON.parse(body));res.writeHead(reject?503:200);res.end('{}');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const dir=mkdtempSync(`${tmpdir()}/dockyard-keeper-watchdog-`),rejectedDir=mkdtempSync(`${tmpdir()}/dockyard-keeper-watchdog-rejected-`),base=`http://127.0.0.1:${server.address().port}`;
 const env={PATH:process.env.PATH,KEEPER_STATUS_URL:base+'/status',KEEPER_STATUS_TOKEN:'test-token',KEEPER_DATA_DIR:dir,
  KEEPER_EXPECTED_KIND:'stock',KEEPER_EXPECTED_MODE:'execute',KEEPER_EXPECTED_VAULT:address(1),KEEPER_EXPECTED_POOL:address(2),
  KEEPER_EXPECTED_GATE:address(3),KEEPER_EXPECTED_COLLATERAL:address(4),KEEPER_EXPECTED_ACCOUNT:address(5),
  KEEPER_EXPECTED_CODE_HASH:hash,KEEPER_EXPECTED_POOL_CODE_HASH:hash,WATCHDOG_ALERT_WEBHOOK_URL:base+'/alerts'};
 async function run(){
  const child=spawn(process.execPath,[new URL('../src/watchdog.mjs',import.meta.url).pathname],{env,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  const exit=await new Promise(r=>child.once('exit',r));return {exit,output};
 }
 try{
  const reported=await run();assert.equal(reported.exit,0);
  assert.doesNotMatch(reported.output,/keeper_stock_binding_mismatch/);assert.equal(messages.length,0);
  const deduplicated=await run();assert.equal(deduplicated.exit,0);
  assert.doesNotMatch(deduplicated.output,/keeper_stock_binding_mismatch/);assert.equal(messages.length,0);
  snapshot.pool=address(9);const wrong=await run();assert.equal(wrong.exit,0);
  assert.match(wrong.output,/keeper_stock_binding_mismatch/);assert.equal(messages.length,1);
  reject=true;env.KEEPER_DATA_DIR=rejectedDir;snapshot.engine=address(8);const undelivered=await run();assert.equal(undelivered.exit,1);
  assert.equal(messages.length,2);
  const alreadySignaled=await run();assert.equal(alreadySignaled.exit,0);assert.equal(messages.length,3);
 }finally{await new Promise(r=>server.close(r));for(const path of [dir,rejectedDir])rmSync(path,{recursive:true,force:true});}
});
