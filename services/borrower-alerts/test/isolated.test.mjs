import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256 } from 'viem';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { IsolatedMonitor,ISOLATED_USDG } from '../src/isolated-monitor.mjs';
import { isolatedAlertsDeployment,bindIsolatedAlertsDeployment } from '../src/isolated-deployment.mjs';
import { resolveAlertsDeployment,bindAlertsRuntime,alertsLinks,createMonitor,activateAlerts } from '../src/runtime.mjs';

const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const wallet=addr(10),vault=addr(20),pool=addr(21),collateral=addr(22),codeHash=keccak256('0x1234');
const env={ALERTS_PROTOCOL:'isolated',ALERTS_VAULT_ADDRESS:vault,ALERTS_VAULT_CODE_HASH:codeHash,
  ALERTS_POOL_ADDRESS:pool,ALERTS_POOL_CODE_HASH:codeHash,ALERTS_COLLATERAL_ADDRESS:collateral,ALERTS_COLLATERAL_CODE_HASH:codeHash,ALERTS_START_BLOCK:'1000'};
const txHash='0x'+'aa'.repeat(32);
function fixture(t) {
  let now=1800000000000;
  const store=new Store(':memory:','ab'.repeat(32));t.after(()=>store.close());
  const sent=[],reads=[];
  const deployment=isolatedAlertsDeployment(env);bindIsolatedAlertsDeployment(store,deployment);
  const engine=new Engine({store,origin:'https://turret.capital',vault,verify:async()=>true,
    send:async(...args)=>sent.push(args),now:()=>now,...alertsLinks('https://turret.capital',deployment)});
  store.put('subscription',`${wallet}:email`,{wallet,channel:'email',contact:'test@example.com',created:now-1000000,failed:false});
  const state={debt:60000000n,principal:50000000n,price:100n*10n**18n,threshold:6500,broken:false,count:0};
  let logs=[];
  const block=number=>({number,hash:`block-${number}`,timestamp:BigInt(Math.floor(now/1000))-2000n+number});
  const client={
    getChainId:async()=>4663,getBlock:async args=>block(args?.blockNumber ?? 2000n),getCode:async()=> '0x1234',
    readContract:async({address,functionName,args,blockNumber})=>{
      reads.push({address,functionName,args,blockNumber});
      if(functionName==='usdg' || functionName==='asset')return ISOLATED_USDG;
      if(functionName==='pool')return pool;
      if(functionName==='collateralToken')return collateral;
      if(functionName==='creditEngine')return vault;
      if(functionName==='decimals')return address.toLowerCase()===ISOLATED_USDG.toLowerCase()?6:18;
      if(functionName==='liquidationLtvBps')return state.threshold;
      if(functionName==='price'){if(state.broken)throw new Error('provider secret');return state.price;}
      if(functionName==='positions')return [10n**18n,state.principal,0n,0n,1n];
      if(functionName==='positionDebt')return state.debt;
      throw new Error('Unexpected function');
    },
    getContractEvents:async()=>logs,
    getTransaction:async()=>({from:wallet,to:vault}),
    getTransactionReceipt:async()=>({status:'reverted',blockNumber:1980n,blockHash:'block-1980'}),
  };
  const monitor=new IsolatedMonitor(engine,client,deployment);
  return {store,engine,monitor,client,sent,reads,state,block,deployment,advance:ms=>now+=ms,
    logs:value=>logs=value,log:(overrides={})=>({address:vault,blockNumber:1980n,blockHash:'block-1980',transactionHash:txHash,logIndex:0,removed:false,
      args:{borrower:wallet,liquidator:addr(30),repaid:90071992547409931234n,seized:1234567891234567890n},...overrides})};
}

test('isolated alert config is explicit and cannot silently adopt stock consent',t=>{
  const h=fixture(t);assert.equal(resolveAlertsDeployment({}).kind,'stock');
  assert.throws(()=>resolveAlertsDeployment({ALERTS_PROTOCOL:'p2p'}));
  for(const name of Object.keys(env).filter(n=>n!=='ALERTS_PROTOCOL')) assert.throws(()=>isolatedAlertsDeployment({...env,[name]:undefined}));
  assert.throws(()=>bindIsolatedAlertsDeployment(h.store,{...h.deployment,vault:addr(44)}),/mismatch/);
  assert.throws(()=>bindAlertsRuntime(h.store,{kind:'stock',vault,codeHash}),/Cannot reassign/);
  const old=new Store(':memory:','cd'.repeat(32));t.after(()=>old.close());
  old.put('subscription','old',{wallet});
  assert.throws(()=>bindIsolatedAlertsDeployment(old,h.deployment),/consent/);
  assert.ok(createMonitor(h.engine,h.client,h.deployment) instanceof IsolatedMonitor);
});

test('stock alert mode requires pinned gate and safe proof URL, with separate consent identity',t=>{
 const h=fixture(t),stockEnv={...env,ALERTS_ISOLATED_MARKET_KIND:'stock',ALERTS_EXECUTION_GATE:addr(50),
  ALERTS_EXECUTION_GATE_CODE_HASH:codeHash,ALERTS_LIVENESS_URL:'https://risk.example/liveness'};
 const d=isolatedAlertsDeployment(stockEnv);assert.equal(d.stock.executionGate,addr(50));
 for(const name of ['ALERTS_EXECUTION_GATE','ALERTS_EXECUTION_GATE_CODE_HASH','ALERTS_LIVENESS_URL'])assert.throws(()=>isolatedAlertsDeployment({...stockEnv,[name]:undefined}));
 for(const patch of [{ALERTS_ISOLATED_MARKET_KIND:'generic'},{ALERTS_ISOLATED_MARKET_KIND:'other'},
  {ALERTS_LIVENESS_URL:'http://risk.example/liveness'},{ALERTS_LIVENESS_URL:'https://user:pass@risk.example/liveness'},
  {ALERTS_LIVENESS_URL:'https://risk.example/liveness?secret=abc'},{ALERTS_EXECUTION_GATE:vault}])assert.throws(()=>isolatedAlertsDeployment({...stockEnv,...patch}));
 assert.throws(()=>bindIsolatedAlertsDeployment(h.store,d),/mismatch/);
});

function stockFixture(t){
 const h=fixture(t),gate=addr(50),old=h.client.readContract;
 h.deployment.stock={executionGate:gate,executionGateCodeHash:codeHash,livenessUrl:'https://risk.example/liveness'};
 h.client.readContract=async request=>request.functionName==='executionGate'?gate:old(request);
 h.client.simulateContract=async request=>{
  assert.equal(request.functionName,'priceWithLiveness');assert.equal(request.address,vault);assert.equal(request.blockNumber,2000n);
  if(h.state.broken)throw new Error('Invalid proof');return {result:h.state.price};
 };
 h.payload=()=>({chainId:4663,vault,executionGate:gate,validUntil:Math.floor(h.engine.now()/1000)+45,encoded:`0x${'ab'.repeat(256)}`});
 h.monitor.fetcher=async(url,options)=>{assert.equal(url,h.deployment.stock.livenessUrl);assert.equal(options.redirect,'error');return new Response(JSON.stringify(h.payload()));};
 return h;
}
test('stock warnings simulate a fresh liveness proof instead of reading expired cached price',async t=>{
 const h=stockFixture(t);h.state.debt=64000000n;
 await h.monitor.scan();assert.equal(h.monitor.healthyAt,h.engine.now());
 assert.equal(h.store.get('risk',`${wallet}:${collateral}`).status,'critical');
 assert.ok(!h.reads.some(r=>r.functionName==='price'));
 await h.engine.deliver();assert.ok(h.sent.length>0);
});
test('a healthy stock scan stays ready during refresh, but a failed refresh invalidates readiness',async t=>{
 const h=stockFixture(t);await h.monitor.scan();
 const healthyAt=h.monitor.healthyAt;h.advance(1000);
 let resume;h.client.getChainId=()=>new Promise(resolve=>{resume=()=>resolve(4663);});
 const pending=h.monitor.scan(),duringRefresh=h.monitor.healthyAt;
 resume();await pending;
 assert.equal(duringRefresh,healthyAt,'A pending refresh must retain the previous successful scan timestamp');
 h.client.getChainId=async()=>1;
 await assert.rejects(h.monitor.scan(),/scan failed/);
 assert.equal(h.monitor.healthyAt,0,'A known validation failure must immediately invalidate readiness');
});
test('stock warning outages and rejected proofs produce unknown risk, never a healthy fabricated price',async t=>{
 const h=stockFixture(t);h.state.debt=64000000n;await h.monitor.scan();
 const valid=h.payload;
 for(const patch of [{chainId:1},{vault:addr(99)},{executionGate:addr(99)},{validUntil:Math.floor(h.engine.now()/1000)+9},
  {validUntil:Math.floor(h.engine.now()/1000)+46},{encoded:'0x00'}]){
  h.payload=()=>({...valid(),...patch});await h.monitor.scan();
  assert.equal(h.monitor.healthyAt,0);assert.equal(h.store.get('risk',`${wallet}:${collateral}`).status,'unknown');
 }
 h.payload=valid;h.state.broken=true;await h.monitor.scan();assert.equal(h.monitor.healthyAt,0);
 h.state.broken=false;await h.monitor.scan();assert.equal(h.monitor.healthyAt,h.engine.now());
 h.monitor.fetcher=async()=>{throw new Error('offline');};await h.monitor.scan();assert.equal(h.monitor.healthyAt,0);
});
test('a stock alert engine cannot be monitored as generic or with the wrong gate runtime',async t=>{
 const h=stockFixture(t),saved=h.deployment.stock;delete h.deployment.stock;
 await assert.rejects(h.monitor.scan());h.deployment.stock=saved;
 h.client.getCode=async({address})=>address===saved.executionGate?'0xabcd':'0x1234';await assert.rejects(h.monitor.scan());
});

test('signature, confirmation and risk messages identify the isolated engine',async t=>{
  const h=fixture(t);
  assert.match(h.engine.challenge(wallet).message,new RegExp(`Vault: ${vault}`));
  h.engine.subscribe(addr(11),'email','other@example.com');
  await h.engine.deliver();
  assert.ok(h.sent.some(s=>s[2].includes(`/alerts/verify?engine=${vault}#`)));
  await h.monitor.scan();await h.engine.deliver();
  assert.ok(h.sent.some(s=>s[2].includes(`/borrow?engine=${vault}`)));
});

test('risk reads use one block, full accrued debt, and on-chain liquidation LTV',async t=>{
  const h=fixture(t);h.state.debt=65000001n;
  await h.monitor.scan();
  assert.equal(h.store.get('risk',`${wallet}:${collateral}`).status,'eligible');
  assert.ok(h.reads.every(r=>r.blockNumber===2000n));
  assert.ok(h.reads.some(r=>r.functionName==='positionDebt'));
  assert.equal(h.monitor.healthyAt,h.engine.now());
  h.state.threshold=7000;h.advance(1);await h.monitor.scan();
  assert.equal(h.store.get('risk',`${wallet}:${collateral}`).status,'warning');
});

test('oracle failure means unknown; repayment can still be recognized as no-debt',async t=>{
  const h=fixture(t);h.state.broken=true;
  await h.monitor.scan();assert.equal(h.monitor.healthyAt,0);
  assert.equal(h.store.get('risk',`${wallet}:${collateral}`).status,'unknown');
  h.state.debt=0n;h.advance(1);await h.monitor.scan();
  assert.equal(h.store.get('risk',`${wallet}:${collateral}`).status,'no-debt');
  assert.equal(h.monitor.healthyAt,0);
});

test('missing stock liveness preserves verified debt monitoring without claiming risk readiness',async t=>{
 const h=stockFixture(t);h.monitor.fetcher=async()=>new Response('{}',{status:503});
 await h.monitor.scan();
 assert.equal(h.monitor.healthyAt,0);
 assert.equal(h.monitor.operationalAt,h.engine.now());
 assert.equal(h.monitor.monitorReason,'liveness_unavailable');
 assert.equal(h.store.get('risk',`${wallet}:${collateral}`).status,'unknown');
 h.state.debt=0n;await h.monitor.scan();
 assert.equal(h.store.get('risk',`${wallet}:${collateral}`).status,'no-debt');
 assert.equal(h.monitor.operationalAt,h.engine.now());
 await h.engine.deliver();assert.equal(h.sent.length,0);
});

test('failed debt reads or chain validation revoke operational alert readiness',async t=>{
 const h=stockFixture(t);await h.monitor.scan();
 const read=h.client.readContract;
 h.client.readContract=async p=>{if(p.functionName==='positionDebt')throw Error('read failed');return read(p);};
 await h.monitor.scan();
 assert.equal(h.monitor.operationalAt,0);assert.equal(h.monitor.monitorReason,'positions_unavailable');
 h.client.readContract=read;await h.monitor.scan();
 h.client.getChainId=async()=>1;
 await assert.rejects(h.monitor.scan());
 assert.equal(h.monitor.operationalAt,0);assert.equal(h.monitor.monitorReason,'unavailable');
});

test('a known debt-read failure revokes monitoring while event recovery is still pending',async t=>{
 const h=stockFixture(t);await h.monitor.scan();
 const read=h.client.readContract;
 h.client.readContract=async p=>{if(p.functionName==='positionDebt')throw Error('read failed');return read(p);};
 let release,started;
 const eventStarted=new Promise(resolve=>{started=resolve;});
 h.monitor.events=()=>{started();return new Promise(resolve=>{release=()=>resolve(true);});};
 const scanning=h.monitor.scan();await eventStarted;
 const during={healthyAt:h.monitor.healthyAt,operationalAt:h.monitor.operationalAt,reason:h.monitor.monitorReason};
 release();await scanning;
 assert.equal(during.healthyAt,0);assert.equal(during.operationalAt,0);
 assert.equal(during.reason,'positions_unavailable');
});

test('wrong chain, changed bytecode and binding mismatch fail closed',async t=>{
  const h=fixture(t);h.client.getChainId=async()=>1;
  await assert.rejects(h.monitor.scan(),/scan failed/);assert.equal(h.monitor.healthyAt,0);
  h.client.getChainId=async()=>4663;h.client.getCode=async()=> '0x00';
  await assert.rejects(h.monitor.scan(),/scan failed/);
  h.client.getCode=async()=> '0x1234';const read=h.client.readContract;
  h.client.readContract=async args=>args.functionName==='creditEngine'?addr(44):read(args);
  await assert.rejects(h.monitor.scan(),/scan failed/);
  assert.equal(h.store.get('risk',`${wallet}:${collateral}`).status,'unknown');
});

test('canonical snapshot check prevents a stale eligibility warning',async t=>{
  const h=fixture(t);h.state.debt=70000000n;
  const getBlock=h.client.getBlock;
  h.client.getBlock=async args=>args?.blockNumber===2000n?{...h.block(2000n),hash:'other'}:getBlock(args);
  await assert.rejects(h.monitor.scan(),/scan failed/);
  await h.engine.deliver();assert.ok(h.sent.every(s=>!s[2].includes('liquidation-eligible')));
  assert.equal(h.store.get('risk',`${wallet}:${collateral}`).status,'unknown');
});

test('confirmed isolated events are recorded and deduplicated without borrower email',async t=>{
  const h=fixture(t);h.logs([h.log()]);
  await h.monitor.events(1988n,h.store.all('subscription'));await h.engine.deliver();
  assert.equal(h.sent.length,0);assert.ok(h.store.get('event',`isolated:${vault}:${txHash}:0`));
  await h.monitor.events(1988n,h.store.all('subscription'));await h.engine.deliver();assert.equal(h.sent.length,0);
});

test('a newly verified channel never receives liquidation from before its own consent',async t=>{
  const h=fixture(t);
  h.store.put('subscription',`${wallet}:telegram`,{wallet,channel:'telegram',contact:'123',created:h.engine.now()});
  h.logs([h.log()]);await h.monitor.events(1988n,h.store.all('subscription'));await h.engine.deliver();
  assert.equal(h.sent.length,0);
});

test('block-anchored consent handles second-resolution event timestamps without losing a later liquidation',async t=>{
  const h=fixture(t);
  h.store.put('subscription',`${wallet}:email`,{wallet,channel:'email',contact:'test@example.com',created:h.engine.now()-19500,startBlock:'1979'});
  h.logs([h.log()]);await h.monitor.events(1988n,h.store.all('subscription'));await h.engine.deliver();
  assert.equal(h.sent.length,0);
});

test('block-anchored consent excludes events already mined when that channel was verified',async t=>{
  const h=fixture(t);
  h.store.put('subscription',`${wallet}:email`,{wallet,channel:'email',contact:'test@example.com',created:h.engine.now()-100000,startBlock:'1980'});
  h.logs([h.log()]);await h.monitor.events(1988n,h.store.all('subscription'));await h.engine.deliver();
  assert.equal(h.sent.length,0);
});

test('activation anchors each channel to a fresh chain head and leaves stock consent unchanged',async t=>{
  const h=fixture(t);
  const email=h.engine.subscribe(wallet,'email','test@example.com');
  await activateAlerts(h.engine,h.client,h.deployment,email,'email');
  assert.equal(h.store.get('subscription',`${wallet}:email`).startBlock,'2000');
  const telegram=h.engine.subscribe(wallet,'telegram');
  await activateAlerts(h.engine,h.client,h.deployment,telegram,'telegram','123');
  assert.equal(h.store.get('subscription',`${wallet}:telegram`).startBlock,'2000');
  const stock=h.engine.subscribe(wallet,'email','test@example.com');
  h.client.getChainId=async()=>{throw new Error('Stock activation must not use RPC');};
  await activateAlerts(h.engine,h.client,{kind:'stock'},stock,'email');
  assert.equal(h.store.get('subscription',`${wallet}:email`).startBlock,undefined);
});

test('failed consent-head checks do not consume the verification link',async t=>{
  const h=fixture(t),token=h.engine.subscribe(wallet,'email','test@example.com');
  h.client.getChainId=async()=>1;
  await assert.rejects(activateAlerts(h.engine,h.client,h.deployment,token,'email'));
  h.client.getChainId=async()=>4663;
  h.client.getBlock=async()=>h.block(999n);
  await assert.rejects(activateAlerts(h.engine,h.client,h.deployment,token,'email'));
  h.client.getBlock=async()=>({...h.block(2000n),timestamp:BigInt(h.engine.now()/1000)-61n});
  await assert.rejects(activateAlerts(h.engine,h.client,h.deployment,token,'email'));
  h.client.getBlock=async()=>h.block(2000n);
  await activateAlerts(h.engine,h.client,h.deployment,token,'email');
  assert.equal(h.store.get('subscription',`${wallet}:email`).startBlock,'2000');
});

test('activation rejects invalid consent block metadata before consuming a link',t=>{
  const h=fixture(t),token=h.engine.subscribe(wallet,'email','test@example.com');
  for(const block of [-1n,123,NaN,'-1','1.5','01','',null]) assert.throws(()=>h.engine.activate(token,'email',undefined,block),/consent block/);
  h.engine.activate(token,'email',undefined,0n);
  assert.equal(h.store.get('subscription',`${wallet}:email`).startBlock,'0');
});

test('a slow event catch-up invalidates the risk snapshot and silently cancels queued warnings',async t=>{
  const h=fixture(t);h.state.debt=70000000n;
  h.client.getContractEvents=async()=>{h.advance(61000);return [];};
  await assert.rejects(h.monitor.scan(),/scan failed/);
  assert.equal(h.monitor.healthyAt,0);
  assert.equal(h.store.get('risk',`${wallet}:${collateral}`).status,'unknown');
  await h.engine.deliver();
  assert.equal(h.sent.length,0);
});

test('revocation while event RPC is pending prevents queued notification',async t=>{
  const h=fixture(t),subs=h.store.all('subscription');
  h.client.getContractEvents=async()=>{h.engine.remove(wallet,'email');return [h.log()];};
  await h.monitor.events(1988n,subs);await h.engine.deliver();assert.equal(h.sent.length,0);
});

test('event backlog is bounded without skipping to head',async t=>{
  const h=fixture(t);let requested;
  h.client.getContractEvents=async args=>{requested=args;return [];};
  assert.equal(await h.monitor.events(5000n,h.store.all('subscription')),false);
  assert.equal(requested.fromBlock,1000n);assert.equal(requested.toBlock,1999n);
  assert.equal(h.store.get('cursor',h.monitor.cursorId).block,'1999');
});

test('a channel activated during an empty-subscriber RPC does not lose its first events',async t=>{
  const h=fixture(t);h.engine.remove(wallet,'email');h.logs([h.log()]);
  const getBlock=h.client.getBlock;let activated=false;
  h.client.getBlock=async args=>{
    if(!activated && args.blockNumber===1988n) {
      activated=true;
      h.store.put('subscription',`${wallet}:email`,{wallet,channel:'email',contact:'test@example.com',created:h.engine.now(),startBlock:'1979'});
    }
    return getBlock(args);
  };
  await h.monitor.events(1988n,[]);await h.engine.deliver();
  assert.equal(h.sent.length,0);
});

for(const [label,change] of [['wrong emitter',{address:addr(66)}],['removed log',{removed:true}],['reorged log',{blockHash:'other'}]]) {
  test(`invalid liquidation ${label} never queues a confirmation`,async t=>{
    const h=fixture(t);h.logs([h.log(change)]);
    await assert.rejects(h.monitor.events(1988n,h.store.all('subscription')));
    assert.equal(h.store.all('outbox').length,0);assert.equal(h.store.get('cursor',h.monitor.cursorId),null);
  });
}

test('cursor reorg requires review rather than replaying notifications',async t=>{
  const h=fixture(t);h.store.put('cursor',h.monitor.cursorId,{block:'1900',hash:'other'});
  await assert.rejects(h.monitor.events(1988n,h.store.all('subscription')),/cursor reorg/);
  assert.equal(h.store.get('cursor',h.monitor.cursorId).block,'1900');
});

test('failed transactions are validated without borrower emails',async t=>{
  const h=fixture(t);await h.monitor.watch(wallet,txHash);
  await h.monitor.transactions(1979n);assert.equal(h.store.all('outbox').length,0);
  h.client.getTransactionReceipt=async()=>({status:'reverted',blockNumber:1980n,blockHash:'other'});
  await assert.rejects(h.monitor.transactions(1988n),/receipt reorg/);assert.equal(h.store.all('outbox').length,0);
  h.client.getTransactionReceipt=async()=>({status:'reverted',blockNumber:1980n,blockHash:'block-1980'});
  await h.monitor.transactions(1988n);await h.engine.deliver();assert.equal(h.sent.length,0);
  h.client.getTransaction=async()=>({from:addr(12),to:vault});await assert.rejects(h.monitor.watch(wallet,txHash));
  h.client.getTransaction=async()=>({from:wallet,to:addr(12)});await assert.rejects(h.monitor.watch(wallet,txHash));
});
