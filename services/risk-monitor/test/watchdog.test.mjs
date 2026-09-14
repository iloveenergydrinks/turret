import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
test('watchdog accepts intentional observation, but defaults to requiring execution',async()=>{
 const server=createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer test-token');res.end(JSON.stringify({mode:'observe',live:true,lastCycle:Date.now(),lastError:null,incidents:[],alertDelivery:{delivered:true}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  for(const [expected,exit] of [['observe',0],['execute',1],[undefined,1],['invalid',1]]){
   const dir=mkdtempSync(`${tmpdir()}/dockyard-risk-watchdog-`);
   try{
    const env={...process.env,RISK_STATUS_URL:`http://127.0.0.1:${server.address().port}/status`,RISK_STATUS_TOKEN:'test-token',RISK_DATA_DIR:dir};
    delete env.RISK_EXPECTED_MODE;if(expected!==undefined)env.RISK_EXPECTED_MODE=expected;
    const child=spawn(process.execPath,[new URL('../src/watchdog.mjs',import.meta.url).pathname],{env,stdio:'ignore'});
    assert.equal(await new Promise(r=>child.on('exit',r)),exit);
   }finally{rmSync(dir,{recursive:true,force:true});}
  }
 }finally{await new Promise(r=>server.close(r));}
});

test('watchdog exits cleanly when the worker already delivered an unchanged critical incident',async()=>{
 const server=createServer((req,res)=>{
  assert.equal(req.headers.authorization,'Bearer test-token');
  res.end(JSON.stringify({mode:'execute',live:true,lastCycle:Date.now(),lastError:null,
   incidents:[{code:'risk_keeper_unavailable',severity:'critical'}],alertDelivery:{delivered:true}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const dir=mkdtempSync(`${tmpdir()}/dockyard-risk-watchdog-`);
 async function run(){
  const env={...process.env,RISK_STATUS_URL:`http://127.0.0.1:${server.address().port}/status`,
   RISK_STATUS_TOKEN:'test-token',RISK_DATA_DIR:dir,RISK_EXPECTED_MODE:'execute'};
  const child=spawn(process.execPath,[new URL('../src/watchdog.mjs',import.meta.url).pathname],{env,stdio:'ignore'});
  return new Promise(r=>child.on('exit',r));
 }
 try{assert.equal(await run(),0);assert.equal(await run(),0);}
 finally{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});

test('independent risk incident succeeds after direct delivery and fails Railway only once when delivery is unavailable',async()=>{
 let reject=false,messages=0;
 const server=createServer(async(req,res)=>{
  if(req.url==='/status')return res.end(JSON.stringify({mode:'observe',live:true,lastCycle:Date.now(),lastError:null,incidents:[],alertDelivery:{delivered:true}}));
  for await(const _ of req){}messages++;res.writeHead(reject?503:200);res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const okDir=mkdtempSync(`${tmpdir()}/dockyard-risk-watchdog-ok-`),failDir=mkdtempSync(`${tmpdir()}/dockyard-risk-watchdog-fail-`);
 async function run(dir){
  const env={...process.env,RISK_STATUS_URL:`http://127.0.0.1:${server.address().port}/status`,RISK_STATUS_TOKEN:'test-token',
   RISK_DATA_DIR:dir,RISK_EXPECTED_MODE:'execute',WATCHDOG_ALERT_WEBHOOK_URL:`http://127.0.0.1:${server.address().port}/alerts`};
  const child=spawn(process.execPath,[new URL('../src/watchdog.mjs',import.meta.url).pathname],{env,stdio:'ignore'});
  return new Promise(r=>child.on('exit',r));
 }
 try{
  assert.equal(await run(okDir),0);assert.equal(messages,1);
  reject=true;assert.equal(await run(failDir),1);assert.equal(messages,2);
  assert.equal(await run(failDir),0);assert.equal(messages,3);
 }finally{await new Promise(r=>server.close(r));for(const path of [okDir,failDir])rmSync(path,{recursive:true,force:true});}
});
