import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const address=x=>'0x'+x.repeat(40);
const manifest={kind:'stock-api3-usdg',chainId:4663,startBlock:'123',relayAddress:address('3'),guardian:address('4'),keeper:address('5'),
  publication:{adapter:address('2'),adapterCodeHash:'0x'+'a'.repeat(64)}};
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port;}
async function close(server){await new Promise(r=>{server.close(r);server.closeAllConnections();});}
async function freePort(){const server=createServer();const port=await listen(server);await close(server);return port;}
function launch(env){
  const child=spawn(process.execPath,[new URL('../src/api3-main.mjs',import.meta.url).pathname],{
    env:{PATH:process.env.PATH,NODE_ENV:'production',...env},stdio:['ignore','pipe','pipe'],
  });
  let output='';child.stdout.on('data',x=>{output+=x;});child.stderr.on('data',x=>{output+=x;});
  const ended=new Promise(r=>{child.once('exit',(code,signal)=>r({code,signal}));child.once('error',()=>r({code:-1}));});
  return {child,ended,output:()=>output};
}
async function stop(run){
  if(run.child.exitCode!==null)return run.ended;
  run.child.kill('SIGTERM');const timer=setTimeout(()=>run.child.kill('SIGKILL'),5000);
  try{return await run.ended;}finally{clearTimeout(timer);}
}
async function status(port,token,run){
  for(let i=0;i<150;i++){
    if(run.child.exitCode!==null)throw Error('API3 service exited before status was available');
    try{const r=await fetch(`http://127.0.0.1:${port}/status`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(500)});
      const j=await r.json();if(r.ok&&j.lastCycle)return j;}catch{}
    await delay(25);
  }
  throw Error('API3 service startup deadline');
}
test('API3 service rejects the wrong chain, protects status, excludes a duplicate instance and restarts without a signer',{timeout:30000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'dockyard-api3-process-')),runs=[],calls=[];
  const rpc=createServer(async(req,res)=>{
    let body='';for await(const p of req)body+=p;
    const request=JSON.parse(body);calls.push(request.method);
    const result=request.method==='eth_chainId'?'0x1':request.method==='eth_getBlockByNumber'?{
      number:'0x100',hash:'0x'+'b'.repeat(64),timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),transactions:[],
    }:null;
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  });
  try{
    const rpcPort=await listen(rpc),port=await freePort(),token='api3-local-status-secret-'.repeat(2);
    const env={PORT:String(port),ORACLE_RPC_URL:`http://127.0.0.1:${rpcPort}/private-rpc-sentinel`,ORACLE_STATUS_TOKEN:token,
      ORACLE_DATA_DIR:directory,ORACLE_POLL_MS:'1000',API3_ORACLE_MANIFEST_JSON:JSON.stringify(manifest)};
    const first=launch(env);runs.push(first);
    const r=await status(port,token,first);
    assert.equal(r.kind,'stock-api3-usdg');assert.equal(r.mode,'observe');assert.equal(r.live,true);assert.equal(r.ready,false);
    assert.ok(r.incidents.some(i=>i.code==='oracle_reconciliation_failed'));
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/ready`)).status,503);
    for(const path of ['/status','/status?token='+token])assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status,401);
    const duplicate=launch({...env,PORT:String(await freePort())});runs.push(duplicate);
    assert.equal((await duplicate.ended).code,1);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,200);
    assert.equal((await stop(first)).code,0);
    const restarted=launch(env);runs.push(restarted);
    assert.equal((await status(port,token,restarted)).ready,false);
    assert.equal((await stop(restarted)).code,0);
    assert.ok(calls.length>=4);assert.ok(calls.every(m=>['eth_chainId','eth_getBlockByNumber'].includes(m)));
    for(const run of runs)for(const secret of [token,'private-rpc-sentinel'])assert.ok(!run.output().includes(secret));
  }finally{
    for(const run of runs)if(run.child.exitCode===null)await stop(run);
    await close(rpc);rmSync(directory,{recursive:true,force:true});
  }
});
