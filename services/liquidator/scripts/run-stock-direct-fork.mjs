import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createPublicClient,http} from 'viem';
import {readOnlyForkProxy} from '../test/read-only-fork-proxy.mjs';

// Exposes only a local, read-only proxy to Foundry. No production private key,
// signer, transaction or provider credential is passed to its process/argv.
async function main(){
 assert.ok(process.argv.slice(2).every(x=>['--railway','--negative-control','--worker','--daemon'].includes(x)));
 let upstream=process.env.STOCK_EARN_FORK_RPC_URL,productionProfitPolicyVerified=false;
 if(process.argv.includes('--railway')){
  const e=JSON.parse(execFileSync('railway',['variable','list','--service','86f47a92-a9fa-44c2-a7cd-3c6de5dcef7d','--json'],
   {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20000}));
  upstream=e.ALCHEMY_RPC_URL;
  const k=JSON.parse(execFileSync('railway',['variable','list','--service','4e7e6c38-6872-43cf-86fc-1727bf08ad99','--json'],
   {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20000}));
  const r=await fetch('https://dockyard-stock-keeper-production.up.railway.app/status',{
   headers:{Authorization:`Bearer ${k.KEEPER_STATUS_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(10000)});
  assert.equal(r.status,200);
  const status=await r.json();
  assert.ok(Date.now()-status.snapshot.checkedAt<60000);
  assert.equal(status.snapshot.engine.toLowerCase(),'0x2a5661e793ebe89256c3665c128a3e9c5618a002');
  assert.deepEqual(status.snapshot.profitPolicy,{absoluteFloor:'1',repaymentBps:50,gasIncluded:false});
  productionProfitPolicyVerified=true;
 }
 assert.ok(upstream,'Explicit RPC or --railway required');
 const c=createPublicClient({transport:http(upstream,{timeout:15000,retryCount:0}),cacheTime:0});
 assert.equal(await c.getChainId(),4663);
 const head=await c.getBlock(),pinned=process.env.STOCK_EARN_FORK_BLOCK?BigInt(process.env.STOCK_EARN_FORK_BLOCK):head.number-12n;
 const block=await c.getBlock({blockNumber:pinned});
 assert.ok(pinned>0n&&pinned<=head.number);
 const proxy=await readOnlyForkProxy(upstream);
 try{
  const negative=process.argv.includes('--negative-control'),daemon=process.argv.includes('--daemon'),worker=daemon||process.argv.includes('--worker');
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),scope:'read-only production fork; local EVM mutations only',forkBlock:String(pinned),blockHash:block.hash,
   negativeControl:negative,worker,daemon,productionProfitPolicyVerified,productionTransactions:0,productionKeyUsed:false}));
  const args=['test','--match-contract','^DockyardAaplCanaryExitForkTest$',
   '--match-test',negative?'^testCanaryFailedSale':'^testCanary','-vv'];
  if(worker)execFileSync('forge',['build','--quiet'],{cwd:new URL('../../../contracts',import.meta.url),stdio:['ignore','pipe','pipe'],timeout:180000,
   env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  const child=spawn(worker?process.execPath:'forge',worker?['--test',new URL('../test/stock-real-pool-worker.integration.mjs',import.meta.url).pathname]:args,{cwd:new URL('../../../contracts',import.meta.url),stdio:['ignore','pipe','pipe'],
   env:{PATH:process.env.PATH,HOME:process.env.HOME,STOCK_EARN_FORK_RPC_URL:proxy.url,STOCK_EARN_FORK_BLOCK:String(pinned),
    STOCK_CANARY_MANIFEST_JSON:readFileSync(new URL('../../../docs/security/evidence/2026-09-03/stock-canary-commissioning.json',import.meta.url),'utf8'),
    ...(daemon?{CANARY_REAL_DAEMON:'1'}:{}),
    ...(negative?(daemon?{CANARY_DAEMON_SKIP_LEASE_WAIT:'1'}:{CANARY_FORK_MIN_PROFIT_OVERRIDE:'1000000'}):{})}});
  for(const stream of [child.stdout,child.stderr])stream.on('data',part=>process.stdout.write(part));
  const timeout=setTimeout(()=>child.kill('SIGTERM'),worker?500000:240000);
  let code;
  try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}
  finally{clearTimeout(timeout);}
  assert.equal((await c.getBlock({blockNumber:pinned})).hash,block.hash,'Pinned source block changed');
  process.exitCode=code??1;
 }finally{await proxy.close();}
}
main().catch(()=>{console.error('Fork check failed; provider details withheld. No production transaction was sent.');process.exitCode=1;});
