import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {parseAbiItem} from 'viem';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function unusedPort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

// Public seams: actual OS entrypoint, authenticated HTTP status, RPC submissions
// and onchain receipts. No worker internals or journal tables are read/replaced.
export async function exerciseDaemonRecovery({env,directory,clockOffset,client,executor,borrower,keeper,
  setProof,setDrop,broadcastCount,alertCount}){
 const port=await unusedPort(),token=randomBytes(32).toString('hex');
 const endpoint=`http://127.0.0.1:${port}/status`;
 const processes=[];let current;
 const start=()=>{
  const process=spawn(globalThis.process.execPath,['--import',new URL('./stock-daemon-clock.mjs',import.meta.url).pathname,
   new URL('../src/isolated/main.mjs',import.meta.url).pathname],{
   env:{PATH:globalThis.process.env.PATH,HOME:globalThis.process.env.HOME,...env,
    NODE_ENV:'production',PORT:String(port),KEEPER_POLL_MS:'1000',KEEPER_STATUS_TOKEN:token,
    KEEPER_DATA_DIR:join(directory,'daemon'),STOCK_FIXTURE_CLOCK_OFFSET_MS:String(clockOffset)},stdio:['ignore','pipe','pipe']});
  const record={process,exited:false,logs:[],code:null,signal:null};processes.push(record);current=record;
  for(const stream of [process.stdout,process.stderr])stream.on('data',part=>{record.logs.push(part.toString());if(record.logs.length>100)record.logs.shift();});
  process.on('error',()=>{record.exited=true;record.code=-1;});
  record.done=new Promise(r=>process.once('exit',(code,signal)=>{record.exited=true;record.code=code;record.signal=signal;r();}));
  return record;
 };
 const stop=async(record,signal)=>{if(!record.exited){record.process.kill(signal);await record.done;}};
 const status=async()=>{
  const response=await fetch(endpoint,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(1000)});
  assert.equal(response.status,200);return response.json();
 };
 const waitFor=async(predicate,label,timeout=30000)=>{
  const end=Date.now()+timeout;
  while(Date.now()<end){assert.equal(current.exited,false,`Daemon exited while ${label} (code ${current.code}, signal ${current.signal})`);
   if(await predicate())return;await pause(100);}
  assert.fail(`Timed out: ${label}`);
 };
 const waitSnapshot=async(predicate,label)=>{
  let found;await waitFor(async()=>{let s;try{s=await status();}catch{return false;}if(predicate(s)){found=s;return true;}return false;},label);return found;
 };
 const crashAndRecover=async(kind,count)=>{
  setDrop(true);setProof(true);
  await waitFor(async()=>broadcastCount()===count,`${kind} broadcast`);
  setProof(false);await stop(current,'SIGKILL');assert.equal(current.signal,'SIGKILL');
  const killedAt=Date.now();
  const rejected=start();await Promise.race([rejected.done,pause(5000)]);
  assert.equal(rejected.exited,true,'Concurrent lease must prevent immediate takeover');assert.equal(rejected.code,1);
  assert.ok(rejected.logs.join('').includes('isolated_startup_failed'));
  assert.equal(broadcastCount(),count);
  if(!globalThis.process.env.CANARY_DAEMON_SKIP_LEASE_WAIT){
   // Real wall-clock expiry, not a changed lease row or a simulated future time.
   console.log(JSON.stringify({event:'daemon_recovery_wait',kind,seconds:123,localForkOnly:true}));
   while(Date.now()-killedAt<123000)await pause(Math.min(1000,123000-(Date.now()-killedAt)));
  }
  start();
  const recovered=await waitSnapshot(s=>s.snapshot?.reconciled&&s.snapshot.pendingTransaction===null,
   `${kind} receipt recovery after real lease expiry`);
  assert.ok(recovered.snapshot.incidents.some(i=>i.code==='execution_liveness_unavailable'));
  assert.equal(broadcastCount(),count,'Receipt reconciliation must not duplicate a submission');
  assert.equal(recovered.lastError,null);
  console.log(JSON.stringify({event:'daemon_recovered',kind,wallClockMilliseconds:Date.now()-killedAt,duplicateBroadcasts:0}));
  return recovered;
 };
 try{
  await client.request({method:'evm_setIntervalMining',params:[1]});
  setProof(false);start();
  await waitSnapshot(s=>s.snapshot?.reconciled&&s.snapshot.incidents.some(i=>i.code==='execution_liveness_unavailable'),'initial fail-closed snapshot');
  assert.equal(broadcastCount(),0);assert.ok(alertCount()>0,'Operator webhook must receive the fault');
  await crashAndRecover('approval',1);
  const recovered=await crashAndRecover('liquidation',2);
  assert.equal(recovered.snapshot.openPositions,0);assert.equal(recovered.snapshot.totalDebt,'0');
  assert.equal(recovered.snapshot.budgets.inventory,'0');
  const logs=await client.getLogs({address:executor,
   event:parseAbiItem('event LiquidationExited(address indexed borrower,address indexed keeper,uint256 paid,uint256 seized,uint256 usdgOut,uint256 profit)'),
   fromBlock:BigInt(globalThis.process.env.STOCK_EARN_FORK_BLOCK),toBlock:'latest'});
  assert.equal(logs.length,1);const sale=logs[0].args;
  assert.equal(sale.borrower.toLowerCase(),borrower.toLowerCase());assert.equal(sale.keeper.toLowerCase(),keeper.toLowerCase());
  assert.equal(recovered.snapshot.budgets.daily,String(sale.paid));
  assert.equal((await client.getTransactionReceipt({hash:logs[0].transactionHash})).status,'success');
  await stop(current,'SIGTERM');assert.equal(current.code,0);
  return {actualRepay:sale.paid,collateralSeized:sale.seized,usdgOut:sale.usdgOut,minProfit:(sale.paid*50n+9999n)/10000n};
 }finally{
  for(const record of processes)await stop(record,'SIGKILL');
  await client.request({method:'evm_setIntervalMining',params:[0]});
  await client.request({method:'evm_setAutomine',params:[true]});
 }
}
