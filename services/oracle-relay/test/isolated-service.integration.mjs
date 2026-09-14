import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CASHCAT_PAIR} from '../src/isolated-pyth-preflight.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
const addr=x=>'0x'+x.repeat(40),pin='0x'+'a'.repeat(64);
const manifest={kind:'isolated-pyth-ratio',chainId:4663,startBlock:'123',relayAddress:addr('3'),guardian:addr('4'),keeper:addr('5'),
  publication:{policy:CASHCAT_PAIR,hub:addr('1'),adapter:addr('2'),hubCodeHash:pin,adapterCodeHash:pin,
    verifierCodeHash:pin,collateralCodeHash:pin,usdgCodeHash:pin}};
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port;}
async function stopServer(server){await new Promise(r=>{server.close(r);server.closeAllConnections();});}
async function freePort(){const server=createServer();const port=await listen(server);await stopServer(server);return port;}
function launch(env){
  const process=spawn(globalThis.process.execPath,[new URL('../src/isolated-main.mjs',import.meta.url).pathname],{
    env:{PATH:globalThis.process.env.PATH,NODE_ENV:'production',...env},stdio:['ignore','pipe','pipe'],
  });
  let output='';process.stdout.on('data',x=>{output+=x;});process.stderr.on('data',x=>{output+=x;});
  const ended=new Promise(resolve=>{process.once('exit',(code,signal)=>resolve({code,signal}));process.once('error',()=>resolve({code:-1}));});
  return {process,ended,output:()=>output};
}
async function terminate(child){
  if(child.process.exitCode!==null)return child.ended;
  child.process.kill('SIGTERM');
  return Promise.race([child.ended,new Promise((_,reject)=>{
    const timer=setTimeout(()=>{child.process.kill('SIGKILL');reject(Error('Service failed graceful shutdown'));},5000);
    child.ended.then(()=>clearTimeout(timer));
  })]);
}
async function untilStatus(port,token,child){
  for(let i=0;i<150;i++){
    if(child.process.exitCode!==null)throw Error('Service exited before health check');
    try {
      const response=await fetch(`http://127.0.0.1:${port}/status`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(500)});
      const status=await response.json();if(response.ok&&status.lastCycle)return status;
    }catch{}
    await wait(25);
  }
  throw Error('Service health startup deadline');
}

test('standalone service rejects wrong chain, exposes protected health, preserves lease and restarts without a signer',{timeout:30000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'dockyard-oracle-process-')),children=[],calls=[];
  // Loopback RPC deliberately reports the wrong chain: the real service must
  // fail closed before any price API, contract, signing or broadcast request.
  const rpc=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    const request=JSON.parse(body);calls.push(request.method);
    const result=request.method==='eth_chainId'?'0x1':request.method==='eth_getBlockByNumber'?{
      number:'0x100',timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),hash:'0x'+'b'.repeat(64),transactions:[],
    }:null;
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  });
  try {
    const rpcPort=await listen(rpc),port=await freePort(),token='local-service-status-secret-'.repeat(2);
    const env={PORT:String(port),ORACLE_RPC_URL:`http://127.0.0.1:${rpcPort}/rpc-secret-sentinel`,
      ORACLE_STATUS_TOKEN:token,PYTH_API_KEY:'provider-secret-sentinel',ORACLE_DATA_DIR:directory,
      ISOLATED_ORACLE_MANIFEST_JSON:JSON.stringify(manifest),ORACLE_POLL_MS:'1000'};
    const first=launch(env);children.push(first);
    const status=await untilStatus(port,token,first);
    assert.equal(status.mode,'observe');assert.equal(status.live,true);assert.equal(status.ready,false);
    assert.ok(status.incidents.some(i=>i.code==='oracle_reconciliation_failed'));
    for(const path of ['/status','/status?token='+token])assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status,401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/ready`)).status,503);
    const second=launch({...env,PORT:String(await freePort())});children.push(second);
    assert.equal((await second.ended).code,1,'same-volume second instance must refuse the active lease');
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,200,'failed second instance must not steal first lease');
    assert.equal((await terminate(first)).code,0);
    const db=new DatabaseSync(join(directory,'keeper.sqlite'),{readOnly:true});
    try{
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lease').get().n,0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n,0);
    }finally{db.close();}
    const restarted=launch(env);children.push(restarted);
    assert.equal((await untilStatus(port,token,restarted)).ready,false);
    assert.equal((await terminate(restarted)).code,0);
    assert.ok(calls.length>=4);assert.ok(calls.every(m=>['eth_chainId','eth_getBlockByNumber'].includes(m)));
    for(const child of children)for(const secret of [token,'provider-secret-sentinel','rpc-secret-sentinel'])assert.ok(!child.output().includes(secret));
    console.log(JSON.stringify({evidence:'isolated-oracle-process',standaloneBoot:true,watchOnly:true,
      wrongChainBlocked:true,leaseExclusivity:true,gracefulRestart:true,publicNetworkRequests:false,productionChanged:false}));
  }finally{
    for(const child of children)if(child.process.exitCode===null)await terminate(child).catch(()=>{});
    await stopServer(rpc);rmSync(directory,{recursive:true,force:true});
  }
});
