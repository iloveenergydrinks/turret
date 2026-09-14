import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters,encodeEventTopics,parseAbiParameters,decodeFunctionData,keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { isolatedConfigFromEnv } from '../src/isolated/config.mjs';
import { IsolatedChain } from '../src/isolated/chain.mjs';
import { IsolatedEngine } from '../src/isolated/engine.mjs';
import { IsolatedTransactions } from '../src/isolated/transactions.mjs';
import { isolatedAbi, exitAbi, MARKET_HEALTH_TYPEHASH } from '../src/isolated/abi.mjs';
import { tokenAbi } from '../src/abi.mjs';
import { Store } from '../src/store.mjs';
import { Chain } from '../src/chain.mjs';

const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const vault=addr(20),pool=addr(21),collateral=addr(22),primary=addr(23),secondary=addr(24),borrower=addr(25);
const account=privateKeyToAccount('0x'+'01'.padStart(64,'0'));
const hash=keccak256('0x1234');
const reverted=name=>({data:{errorName:name}});
const env={
  KEEPER_RPC_URL:'https://example.invalid',ISOLATED_ENGINE_ADDRESS:vault,ISOLATED_POOL_ADDRESS:pool,
  ISOLATED_COLLATERAL_ADDRESS:collateral,ISOLATED_PRIMARY_ORACLE:primary,ISOLATED_SECONDARY_ORACLE:secondary,
  ISOLATED_ENGINE_CODE_HASH:hash,ISOLATED_POOL_CODE_HASH:hash,ISOLATED_COLLATERAL_CODE_HASH:hash,
  ISOLATED_PRIMARY_CODE_HASH:hash,ISOLATED_SECONDARY_CODE_HASH:hash,
};
const stockEnv={...env,ISOLATED_MARKET_KIND:'stock',KEEPER_EXECUTION_GATE:addr(70),KEEPER_LIVENESS_URL:'https://risk.example.test/liveness',
  STOCK_GUARDIAN_ADDRESS:addr(71),STOCK_USDG_PRIMARY_ORACLE:addr(72),STOCK_USDG_SECONDARY_ORACLE:addr(73),
  STOCK_EXECUTION_GATE_CODE_HASH:hash,STOCK_USDG_CODE_HASH:hash,STOCK_USDG_PRIMARY_CODE_HASH:hash,STOCK_USDG_SECONDARY_CODE_HASH:hash};
test('stock configuration requires gate, separate USDG feeds, guardian and explicit runtime pins',()=>{
  const c=isolatedConfigFromEnv(stockEnv);assert.equal(c.marketKind,'stock');assert.equal(c.stock.guardian,addr(71));
  for(const key of Object.keys(stockEnv).filter(k=>k.startsWith('STOCK_')||k==='KEEPER_EXECUTION_GATE'||k==='KEEPER_LIVENESS_URL')){
    assert.throws(()=>isolatedConfigFromEnv({...stockEnv,[key]:undefined}));
  }
  for(const change of [{STOCK_USDG_PRIMARY_ORACLE:primary},{STOCK_USDG_SECONDARY_ORACLE:addr(72)},
    {ISOLATED_MARKET_KIND:'generic'},{KEEPER_LIVENESS_URL:'https://secret@risk.example.test/liveness'}]){
    assert.throws(()=>isolatedConfigFromEnv({...stockEnv,...change}));
  }
});
function harness(t) {
  const store=new Store(':memory:',{protocol:'isolated'});store.acquireLease();t.after(()=>store.close());
  const config={...isolatedConfigFromEnv(env),mode:'execute',retainCollateral:true,
    maxRepay:20n,dailyBudget:100n,inventoryBudget:100n,minUsdg:1n,minEth:1n,slippageBps:100,
    maxTxFee:10n**15n,maxDailyGas:10n**16n,confirmations:2n,replaceAfterMs:1,maxReplacements:2,
    alertWebhook:'https://example.invalid/alerts'};
  const block={number:100n,hash:'blockhash',timestamp:1000000n};
  const readValues={activeDebtPositions:1n,riskPaused:false,price:10n**18n};
  const capitalValues={debtLimit:100n,outstandingPrincipal:90n,interestReceivable:10n,pendingInterest:0n,availableCash:100n};
  let allowance=0n,balance=1000n;
  const calls=[];
  const chain={account,consistent:true,codeHash:hash,probeStatus:[],active:{name:'rpc_1'},
    select:async()=>block,verifyDeployment:async()=>true,
    read:async(name,args=[],blockNumber)=>{
      calls.push({name,args,blockNumber});
      if(name==='activeBorrowerAt') return borrower;
      if(name==='positions') return [1000n,90n,10n,0n,1n];
      if(name==='positionDebt') return 100n;
      if(name==='liquidationQuote') return [20n,200n];
      return readValues[name];
    },capital:async(name,args,blockNumber)=>{calls.push({name,blockNumber});return capitalValues[name];},
    token:async(address,name,args,blockNumber)=>{
      calls.push({name,args,blockNumber});
      return name==='allowance'?allowance:balance;
    },client:{
      getBlock:async()=>block,getBalance:async()=>10n**18n,getTransactionCount:async()=>0,
      simulateContract:async({functionName})=>({result:functionName==='approve'?true:[20n,200n]}),
      sendRawTransaction:async()=>{throw Object.assign(new Error('secret-url-must-not-appear'),{name:'TimeoutError'});},
      getTransactionReceipt:async()=>{throw Object.assign(new Error(),{name:'TransactionReceiptNotFoundError'});},
    },wallet:{prepareTransactionRequest:async args=>({...args,chainId:4663,type:'legacy',gas:100000n,gasPrice:1n})},
  };
  const txs=new IsolatedTransactions(chain,store,config);
  return {store,config,chain,txs,calls,readValues,capitalValues,block,
    allowance:v=>allowance=v,balance:v=>balance=v,
    engine:()=>new IsolatedEngine(chain,store,config,txs)};
}

test('isolated config never defaults to stock vault and requires all runtime pins',()=>{
  assert.throws(()=>isolatedConfigFromEnv({KEEPER_RPC_URL:env.KEEPER_RPC_URL}));
  const c=isolatedConfigFromEnv(env);assert.equal(c.vault,vault);assert.equal(c.mode,'observe');assert.equal(c.retainCollateral,false);
  for(const name of Object.keys(env).filter(k=>k.endsWith('CODE_HASH'))) {
    assert.throws(()=>isolatedConfigFromEnv({...env,[name]:undefined}));
  }
  assert.throws(()=>isolatedConfigFromEnv({...env,ISOLATED_SECONDARY_ORACLE:primary}));
  assert.throws(()=>isolatedConfigFromEnv({...env,ISOLATED_COLLATERAL_SLIPPAGE_BPS:'501'}));
  assert.throws(()=>isolatedConfigFromEnv({...env,KEEPER_COLLATERAL_RECIPIENT:addr(90)}));
});

test('observe discovers bounded registry and quotes every position at one block without signing',async t=>{
  const h=harness(t);h.config.mode='observe';
  const s=await h.engine().cycle();
  assert.equal(s.reconciled,true);assert.equal(s.openPositions,1);assert.equal(s.unhealthyPositions,1);
  assert.equal(s.totalDebt,100n);assert.equal(h.store.pendingTx(),undefined);
  assert.ok(h.calls.every(c=>c.blockNumber===100n));
});

test('isolated scans cache deployment bindings while transaction preparation rechecks them',async t=>{
  const h=harness(t);h.config.mode='observe';h.config.deploymentVerifyIntervalMs=60000;
  let verifications=0;h.chain.verifyDeployment=async()=>{verifications++;return true;};
  const engine=h.engine();await engine.cycle();await engine.cycle();
  assert.equal(verifications,1);
  h.config.mode='execute';await h.txs.liquidate({borrower,collateral});
  assert.equal(verifications,2);
});

test('USDG reserve covers the debt limit and accrued interest, independent of excess lender cash',async t=>{
  const h=harness(t);h.capitalValues.availableCash=1000n;h.balance(110n);
  const s=await h.engine().cycle();
  assert.equal(s.debtLimit,100n);
  assert.equal(s.incidents.some(i=>i.code==='usdg_reserve'),false);
});

test('paused new risk does not prevent liquidation and approval is bounded',async t=>{
  const h=harness(t);h.readValues.riskPaused=true;
  const s=await h.engine().cycle();assert.equal(s.paused,true);
  const tx=h.store.pendingTx();assert.equal(tx.kind,'approval');
  const decoded=decodeFunctionData({abi:tokenAbi,data:tx.request.data});
  assert.deepEqual(decoded.args,[vault,20n]);assert.equal(tx.maxRepay,0n);
});

test('isolated execution distinguishes unavailable RPC comparison from conflicting hashes and blocks both',async t=>{
  for(const failure of ['timeout','conflict'])await t.test(failure,async t=>{
    const h=harness(t);
    const rpc=new Chain({...h.config,rpcUrls:['http://localhost:1111','http://localhost:2222'],maxHeadAgeSeconds:30});
    const head={...h.block,timestamp:BigInt(Math.floor(Date.now()/1000))};
    for(const [i,p] of rpc.providers.entries())p.client={getChainId:async()=>4663,getBlock:async args=>{
      if(i===1&&args?.blockNumber!==undefined&&failure==='timeout')throw Object.assign(new Error('secret-provider-url'),{name:'TimeoutError'});
      return {...head,hash:i===1&&failure==='conflict'?'different-hash':head.hash};
    }};
    h.chain.select=async()=>{await rpc.select();h.chain.consistent=rpc.consistent;h.chain.consistency=rpc.consistency;return h.block;};
    const snapshot=await h.engine().cycle();
    const expected=failure==='conflict'?'rpc_disagreement':'rpc_comparison_unavailable';
    const alert=snapshot.incidents.find(i=>i.code===expected);
    assert.equal(alert?.severity,'critical');
    assert.equal(alert?.details.blockNumber,100n);
    assert.equal(snapshot.rpcConsistency.status,failure==='conflict'?'hash_mismatch':'unavailable');
    assert.equal(h.store.pendingTx(),undefined,'No approval or liquidation may be signed while comparison is blocked');
    assert.doesNotMatch(JSON.stringify(alert,(_,v)=>typeof v==='bigint'?String(v):v),/secret-provider-url/);
  });
});

test('fresh quote sets nonzero collateral minimum and journals calldata before uncertain broadcast',async t=>{
  const h=harness(t);h.allowance(100n);
  const alerts=await h.txs.liquidate({borrower,collateral});
  assert.equal(alerts[0].code,'broadcast_uncertain');
  const tx=h.store.pendingTx();assert.equal(tx.kind,'liquidation');assert.equal(tx.minCollateral,198n);
  assert.deepEqual(decodeFunctionData({abi:isolatedAbi,data:tx.request.data}).args,[borrower,20n,198n]);
  assert.equal(tx.attempts.length,1);assert.equal(h.store.budgets().inventory,20n);
  assert.ok(!JSON.stringify(alerts).includes('secret-url'));
});

test('approval covers the bounded spend cap so accruing interest cannot cause endless approval retries',async t=>{
  const h=harness(t);h.config.maxRepay=40n;
  await h.txs.liquidate({borrower,collateral});
  const approval=decodeFunctionData({abi:tokenAbi,data:h.store.pendingTx().request.data});
  assert.deepEqual(approval.args,[vault,40n]);
});

test('transaction cap accommodates accrued interest without exceeding authorized budgets',async t=>{
  const h=harness(t);h.allowance(40n);h.config.maxRepay=40n;
  h.chain.client.simulateContract=async()=>({result:[21n,210n]});
  await h.txs.liquidate({borrower,collateral});
  const tx=h.store.pendingTx();
  assert.equal(tx.maxRepay,40n);
  assert.equal(decodeFunctionData({abi:isolatedAbi,data:tx.request.data}).args[1],40n);
});

function enableAtomic(h) {
  h.config.executor=addr(26);h.config.executorCodeHash=hash;h.config.minProfit=5n;h.config.retainCollateral=false;
  h.allowance(100n);h.chain.client.simulateContract=async()=>({result:[20n,200n,30n]});
}

test('one-USDG loan uses proportional gross profit instead of the legacy one-dollar floor',async t=>{
  const h=harness(t);enableAtomic(h);
  const policy=isolatedConfigFromEnv({...env,ISOLATED_MIN_PROFIT_USDG:'0.000001',ISOLATED_MIN_PROFIT_BPS:'50'});
  Object.assign(h.config,{minProfit:policy.minProfit,minProfitBps:policy.minProfitBps,maxRepay:50000000n,dailyBudget:100000000n,inventoryBudget:100000000n});
  h.balance(100000000n);h.allowance(100000000n);
  const read=h.chain.read;
  h.chain.read=async(name,...rest)=>name==='liquidationQuote'?[1000000n,10500000000000000n]:read(name,...rest);
  h.chain.client.simulateContract=async({args})=>{
    assert.equal(args[3],5000n,'0.5% of quoted $1 repayment, not the $50 spend cap');
    return {result:[1000000n,10500000000000000n,1040000n]};
  };
  await h.txs.liquidate({borrower,collateral});
  const tx=h.store.pendingTx();assert.ok(tx,'Actual transaction path must prepare a bounded liquidation');
  assert.equal(tx.minProfit,5000n);
  assert.equal(decodeFunctionData({abi:exitAbi,data:tx.request.data}).args[3],5000n);
});

test('proportional profit rounds up, retains a positive floor and is recomputed after sizing',async t=>{
  const h=harness(t);enableAtomic(h);sizedQuotes(h);
  Object.assign(h.config,{minProfit:1n,minProfitBps:5000,maxRepay:80n});
  const attempts=[];
  h.chain.client.simulateContract=async({args})=>{
    attempts.push([args[1],args[3]]);
    if(args[1]>5n)throw reverted('InsufficientReturn');
    return {result:[5n,50n,8n]};
  };
  await h.txs.liquidate({borrower,collateral});
  assert.deepEqual(attempts,[[80n,10n],[10n,5n],[5n,3n]]);
  assert.equal(h.store.pendingTx()?.minProfit,3n);
});

test('profit basis points are explicit, bounded integers; legacy defaults are unchanged',()=>{
  assert.equal(isolatedConfigFromEnv(env).minProfitBps,0);
  assert.equal(isolatedConfigFromEnv(env).minProfit,1000000n);
  for(const value of ['-1','1.5','10001','NaN','1e2','']){
    assert.throws(()=>isolatedConfigFromEnv({...env,ISOLATED_MIN_PROFIT_BPS:value}));
  }
  assert.equal(isolatedConfigFromEnv({...env,ISOLATED_MIN_PROFIT_BPS:'50'}).minProfitBps,50);
});

test('proportional policy never waives its absolute floor, even on a dust repayment',async t=>{
  const h=harness(t);enableAtomic(h);h.config.minProfitBps=50;
  h.chain.read=async()=>[1n,10n];
  h.chain.client.simulateContract=async({args})=>{assert.equal(args[3],5n);return {result:[1n,10n,5n]};};
  const incidents=await h.txs.liquidate({borrower,collateral});
  assert.equal(incidents[0].severity,'critical');assert.equal(h.store.pendingTx(),undefined);
});

test('receipt recovery enforces the signed threshold, not a subsequently lowered policy',async t=>{
  const h=harness(t);enableAtomic(h);await h.txs.liquidate({borrower,collateral});
  h.config.minProfit=1n;h.config.minProfitBps=0;
  h.chain.client.getTransactionReceipt=async()=>atomicReceipt(h,{usdgOut:24n,profit:4n});
  await h.txs.recover({number:102n},false);
  assert.equal(h.store.pendingTx().status,'blocked');assert.equal(h.store.pendingTx().minProfit,5n);
});
function atomicReceipt(h,{usdgOut=30n,profit=10n,seized=200n,omitExit=false,omitEngine=false}={}) {
  const tx=h.store.pendingTx();
  const engineLog={address:vault,topics:encodeEventTopics({abi:isolatedAbi,eventName:'Liquidated',args:{borrower,liquidator:h.config.executor}}),
    data:encodeAbiParameters(parseAbiParameters('uint256,uint256'),[20n,200n])};
  const exitLog={address:h.config.executor,topics:encodeEventTopics({abi:exitAbi,eventName:'LiquidationExited',args:{borrower,keeper:account.address}}),
    data:encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'),[20n,seized,usdgOut,profit])};
  return {transactionHash:tx.attempts[0].hash,blockNumber:100n,blockHash:'blockhash',status:'success',gasUsed:100000n,effectiveGasPrice:1n,
    logs:[...omitEngine?[]:[engineLog],...omitExit?[]:[exitLog]]};
}

test('atomic calldata has profit and deadline; only confirmed matched sale releases inventory cost',async t=>{
  const h=harness(t);enableAtomic(h);
  await h.txs.liquidate({borrower,collateral});
  const tx=h.store.pendingTx();assert.equal(tx.request.to,h.config.executor);
  assert.deepEqual(decodeFunctionData({abi:exitAbi,data:tx.request.data}).args,[borrower,20n,198n,5n,1000120n]);
  assert.equal(h.store.budgets().inventory,20n);
  const r=atomicReceipt(h);h.chain.client.getTransactionReceipt=async()=>r;
  await h.txs.recover({number:101n},false);assert.equal(h.store.budgets().inventory,20n);
  await h.txs.recover({number:102n},false);
  assert.equal(h.store.budgets().inventory,0n);assert.equal(h.store.budgets().daily,20n);
  assert.equal(h.store.transactions()[0].usdgOut,30n);
});

for(const [label,args] of [['no exit',{omitExit:true}],['no liquidation',{omitEngine:true}],['below profit',{usdgOut:24n,profit:4n}],['wrong profit',{profit:99n}],['wrong seizure',{seized:201n}]]) {
  test(`atomic inventory recovery rejects ${label}`,async t=>{
    const h=harness(t);enableAtomic(h);await h.txs.liquidate({borrower,collateral});
    const r=atomicReceipt(h,args);h.chain.client.getTransactionReceipt=async()=>r;
    await h.txs.recover({number:102n},false);
    assert.equal(h.store.pendingTx().status,'blocked');assert.equal(h.store.budgets().inventory,20n);
  });
}

test('atomic low-return simulation never signs',async t=>{
  const h=harness(t);enableAtomic(h);h.chain.client.simulateContract=async()=>({result:[20n,200n,24n]});
  const incidents=await h.txs.liquidate({borrower,collateral});
  assert.equal(incidents[0].severity,'critical');assert.equal(h.store.pendingTx(),undefined);
});

function sizedQuotes(h) {
  const read=h.chain.read;
  h.chain.read=async(name,args,at)=>{
    if (name!=='liquidationQuote') return read(name,args,at);
    h.calls.push({name,args,blockNumber:at});
    const paid=args[1]<20n?args[1]:20n;
    return [paid,paid*10n];
  };
}

test('atomic execution uses the dust-safe quoted fill without raising the funded cap',async t=>{
  const h=harness(t);enableAtomic(h);h.config.maxRepay=19999999n;
  h.config.dailyBudget=100000000n;h.config.inventoryBudget=100000000n;
  h.config.minProfitBps=50;h.balance(30000000n);h.allowance(30000000n);
  const read=h.chain.read;
  h.chain.read=async(name,...rest)=>name==='liquidationQuote'?[19000000n,950000000000000000n]:read(name,...rest);
  h.chain.client.simulateContract=async request=>{
    assert.equal(request.args[1],19999999n);
    assert.equal(request.args[3],95000n,'Profit threshold follows the reduced fill');
    return {result:[19000000n,950000000000000000n,19950000n]};
  };
  await h.txs.liquidate({borrower,collateral});
  assert.equal(h.store.pendingTx().maxRepay,19999999n);
  assert.equal(h.store.pendingTx().minProfit,95000n);
});

test('an underfunded minimum-size loan is reported without signing or weakening the quote',async t=>{
  const h=harness(t);enableAtomic(h);
  let quotes=0,simulations=0;
  h.chain.read=async name=>{assert.equal(name,'liquidationQuote');quotes++;throw reverted('InvalidAmount');};
  h.chain.client.simulateContract=async()=>{simulations++;};
  const incidents=await h.txs.liquidate({borrower,collateral});
  assert.equal(quotes,1);assert.equal(simulations,0);
  assert.equal(h.store.pendingTx(),undefined);
  assert.equal(incidents[0].details.error,'InvalidAmount');
});

test('atomic sizing halves actual quoted debt at one block and preserves profit and budget limits',async t=>{
  const h=harness(t);enableAtomic(h);sizedQuotes(h);h.config.maxRepay=80n;
  const attempts=[];
  h.chain.verifyDeployment=async at=>assert.equal(at,100n);
  h.chain.client.simulateContract=async request=>{
    attempts.push(request);
    if(request.args[1]>5n) throw reverted('InsufficientReturn');
    return {result:[5n,50n,10n]};
  };
  await h.txs.liquidate({borrower,collateral});
  assert.deepEqual(attempts.map(r=>r.args[1]),[80n,10n,5n]);
  assert.ok(attempts.every(r=>r.blockNumber===100n && r.args[3]===5n && r.args[4]===1000120n));
  assert.ok(h.calls.every(c=>c.blockNumber===100n));
  const tx=h.store.pendingTx();
  assert.equal(tx.maxRepay,5n);assert.equal(tx.sizingAttempts,3);
  assert.equal(h.store.budgets().inventory,5n);
  assert.deepEqual(decodeFunctionData({abi:exitAbi,data:tx.request.data}).args,[borrower,5n,49n,5n,1000120n]);
});

test('atomic sizing stops after four unsuccessful simulations without signing',async t=>{
  const h=harness(t);enableAtomic(h);sizedQuotes(h);const caps=[];
  h.chain.client.simulateContract=async({args})=>{caps.push(args[1]);throw reverted('InsufficientReturn');};
  const incidents=await h.txs.liquidate({borrower,collateral});
  assert.deepEqual(caps,[20n,10n,5n,2n]);
  assert.equal(h.store.pendingTx(),undefined);assert.equal(h.store.budgets().inventory,0n);
  assert.equal(incidents[0].details.error,'NoExecutableLiquidationSize');
});

for(const reason of ['OracleUnavailable','RouteChanged','UnsupportedTransfer']) {
  test(`atomic sizing does not retry ${reason}`,async t=>{
    const h=harness(t);enableAtomic(h);let attempts=0;
    h.chain.client.simulateContract=async()=>{attempts++;throw reverted(reason);};
    await h.txs.liquidate({borrower,collateral});
    assert.equal(attempts,1);assert.equal(h.store.pendingTx(),undefined);
  });
}

for(const mode of ['reorg','expired']) {
  test(`liquidation preparation rejects a ${mode} snapshot before signing`,async t=>{
    const h=harness(t);enableAtomic(h);let reads=0;
    h.chain.client.getBlock=async args=>{
      reads++;
      if(reads===1) return h.block;
      if(args?.blockNumber) return {...h.block,hash:mode==='reorg'?'changed':h.block.hash};
      return {...h.block,number:101n,timestamp:h.block.timestamp+(mode==='expired'?31n:1n)};
    };
    const incidents=await h.txs.liquidate({borrower,collateral});
    assert.equal(incidents[0].severity,'critical');assert.equal(h.store.pendingTx(),undefined);
  });
}

test('atomic config requires matched address/hash and a positive exact-six-decimal profit floor',()=>{
  assert.throws(()=>isolatedConfigFromEnv({...env,ISOLATED_EXIT_ADDRESS:addr(26)}));
  for(const value of ['0','-1','0.0000001','NaN','1e3']) assert.throws(()=>isolatedConfigFromEnv({...env,ISOLATED_MIN_PROFIT_USDG:value}));
  const c=isolatedConfigFromEnv({...env,ISOLATED_EXIT_ADDRESS:addr(26),ISOLATED_EXIT_CODE_HASH:hash,ISOLATED_MIN_PROFIT_USDG:'0.1'});
  assert.equal(c.minProfit,100000n);assert.equal(c.executor,addr(26));assert.equal(c.retainCollateral,false);
});

test('stale pricing preserves receipt reconciliation but never starts a liquidation',async t=>{
  const h=harness(t);const read=h.chain.read;
  h.chain.read=async(name,...rest)=>{if(name==='price')throw reverted('OracleUnavailable');return read(name,...rest);};
  let recovered=false;
  h.txs.recover=async(head,canBroadcast)=>{recovered=true;assert.equal(canBroadcast,false);return [];};
  const s=await h.engine().cycle();assert.equal(recovered,true);
  assert.ok(s.incidents.some(i=>i.code==='oracle_blocked'));assert.equal(h.store.pendingTx(),undefined);
});

test('principal mismatch, duplicate registry, excessive registry and reorg block sends',async t=>{
  const h=harness(t);h.capitalValues.outstandingPrincipal=91n;
  const s=await h.engine().cycle();assert.equal(s.reconciled,false);assert.equal(h.store.pendingTx(),undefined);
  h.readValues.activeDebtPositions=2n;await assert.rejects(h.engine().cycle(),/Duplicate/);
  h.readValues.activeDebtPositions=65n;await assert.rejects(h.engine().cycle(),/registry size/);
  h.readValues.activeDebtPositions=1n;h.chain.client.getBlock=async()=>({hash:'other'});
  await assert.rejects(h.engine().cycle(),/Reorg/);assert.equal(h.store.pendingTx(),undefined);
});

test('no funds, disabled inventory retention and exhausted budgets do not sign',async t=>{
  const h=harness(t);h.balance(0n);
  assert.equal((await h.txs.liquidate({borrower,collateral}))[0].code,'liquidation_unfunded');
  h.balance(100n);h.config.retainCollateral=false;
  assert.equal((await h.txs.liquidate({borrower,collateral}))[0].code,'exit_policy_missing');
  h.config.retainCollateral=true;h.config.inventoryBudget=0n;
  assert.equal((await h.txs.liquidate({borrower,collateral}))[0].code,'capital_budget');
  assert.equal(h.store.pendingTx(),undefined);
});

test('healthy race, code mismatch and invalid simulation never send a liquidation',async t=>{
  const h=harness(t);h.allowance(100n);const read=h.chain.read;
  h.chain.read=async(name,...rest)=>{if(name==='liquidationQuote')throw reverted('HealthyPosition');return read(name,...rest);};
  assert.deepEqual(await h.txs.liquidate({borrower,collateral}),[]);
  h.chain.read=read;h.chain.verifyDeployment=async()=>{throw new Error('mismatch');};
  assert.equal((await h.txs.liquidate({borrower,collateral}))[0].severity,'critical');
  h.store.set(`retry:${collateral}:${borrower}`,0);h.chain.verifyDeployment=async()=>true;
  h.chain.client.simulateContract=async()=>({result:[20n,197n]});
  assert.equal((await h.txs.liquidate({borrower,collateral}))[0].severity,'critical');
  assert.equal(h.store.pendingTx(),undefined);
});

function receipt(h,{repaid=20n,seized=200n,who=borrower,from=vault,duplicate=false}={}) {
  const tx=h.store.pendingTx();
  const log={address:from,topics:encodeEventTopics({abi:isolatedAbi,eventName:'Liquidated',args:{borrower:who,liquidator:account.address}}),
    data:encodeAbiParameters(parseAbiParameters('uint256,uint256'),[repaid,seized])};
  return {transactionHash:tx.attempts[0].hash,blockNumber:100n,blockHash:'blockhash',status:'success',gasUsed:100000n,effectiveGasPrice:1n,logs:duplicate?[log,log]:[log]};
}

test('canonical isolated receipt consumes exact budget and recovery works in observe mode',async t=>{
  const h=harness(t);h.allowance(100n);await h.txs.liquidate({borrower,collateral});
  const r=receipt(h);h.chain.client.getTransactionReceipt=async()=>r;
  h.config.mode='observe';await h.txs.recover({number:101n},false);assert.ok(h.store.pendingTx());
  await h.txs.recover({number:102n},false);assert.equal(h.store.pendingTx(),undefined);
  assert.equal(h.store.transactions()[0].actualRepay,20n);assert.equal(h.store.transactions()[0].collateralSeized,200n);
  assert.equal(h.store.budgets().inventory,20n);
});

for (const [label,args] of [['wrong borrower',{who:addr(50)}],['wrong emitter',{from:addr(50)}],['below minimum',{seized:197n}],['duplicate event',{duplicate:true}],['overpayment',{repaid:21n}]]) {
  test(`isolated receipt rejects ${label}`,async t=>{
    const h=harness(t);h.allowance(100n);await h.txs.liquidate({borrower,collateral});
    const r=receipt(h,args);h.chain.client.getTransactionReceipt=async()=>r;
    const incidents=await h.txs.recover({number:102n},false);
    assert.equal(incidents[0].code,'liquidation_receipt_mismatch');assert.equal(h.store.pendingTx().status,'blocked');
  });
}

test('deployment verification binds engine, pool, token and both oracle runtimes',async()=>{
  const c=isolatedConfigFromEnv(env),chain=new IsolatedChain(c);
  const data={usdg:c.usdg,collateralToken:collateral,pool,primary,secondary,owner:addr(99),MAX_ACTIVE_POSITIONS:64n,
    asset:c.usdg,creditEngine:vault};
  chain.active={client:{getCode:async()=> '0x1234',readContract:async({address,functionName})=>functionName==='decimals'?(address===c.usdg?6:18):data[functionName]}};
  assert.equal(await chain.verifyDeployment(100n),true);
  data.creditEngine=addr(88);await assert.rejects(chain.verifyDeployment(100n),/binding mismatch/);
  data.creditEngine=vault;chain.account={address:addr(99)};await assert.rejects(chain.verifyDeployment(100n),/guardian/);
  chain.account=undefined;chain.active.client.getCode=async()=> '0x00';
  await assert.rejects(chain.verifyDeployment(100n),/runtime mismatch/);
});

test('stock scan checks liveness even without loans and blocks all new sends on outage',async t=>{
  const h=harness(t);h.config.stock={};h.config.marketKind='stock';h.readValues.activeDebtPositions=0n;
  h.capitalValues.outstandingPrincipal=0n;h.capitalValues.interestReceivable=0n;
  let reads=0;h.chain.stockLiveness=async()=>{reads++;throw new Error('service down');};
  const s=await h.engine().cycle();
  assert.equal(reads,1);assert.equal(s.openPositions,0);
  assert.ok(s.incidents.some(i=>i.code==='execution_liveness_unavailable'));
  assert.equal(s.incidents.some(i=>i.code==='oracle_blocked'),false,'A missing liveness proof is not a second oracle failure');
  assert.equal(h.store.pendingTx(),undefined);
});

for(const atomic of [false,true])test(`stock ${atomic?'atomic':'retained'} liquidation carries fresh proof in durable calldata`,async t=>{
  const h=harness(t);if(atomic)enableAtomic(h);else h.allowance(100n);
  h.config.stock={};h.config.marketKind='stock';h.chain.stockLiveness=async()=> '0x1234';
  h.chain.stockQuote=async(_borrower,_maximum,block,proof)=>{assert.equal(block,100n);assert.equal(proof,'0x1234');return [20n,200n];};
  await h.txs.liquidate({borrower,collateral});
  const tx=h.store.pendingTx();assert.equal(tx.kind,'liquidation');
  const decoded=decodeFunctionData({abi:atomic?exitAbi:isolatedAbi,data:tx.request.data});
  assert.equal(decoded.functionName,atomic?'liquidateAndSellChecked':'liquidateChecked');
  assert.equal(decoded.args.at(-1),'0x1234');
  assert.equal(h.store.budgets().inventory,20n);
});

test('unavailable or rejected stock liveness cannot grant even a token approval',async t=>{
  const h=harness(t);h.config.stock={};h.config.marketKind='stock';
  h.chain.stockLiveness=async()=>{throw new Error('offline');};
  await h.txs.liquidate({borrower,collateral});assert.equal(h.store.pendingTx(),undefined);
  h.store.set(`retry:${collateral}:${borrower}`,0);
  h.chain.stockLiveness=async()=> '0x1234';h.chain.stockQuote=async()=>{throw reverted('LivenessExpired');};
  await h.txs.liquidate({borrower,collateral});assert.equal(h.store.pendingTx(),undefined);
});

test('stock deployment verification detects gate, feed, guardian and runtime mismatches',async()=>{
  const c=isolatedConfigFromEnv(stockEnv),chain=new IsolatedChain(c);
  const data={usdg:c.usdg,collateralToken:collateral,pool,primary,secondary,owner:addr(99),MAX_ACTIVE_POSITIONS:64n,
    asset:c.usdg,creditEngine:vault,executionGate:c.executionGate,stockGuard:secondary,usdgPrimary:c.stock.usdgPrimary,
    usdgSecondary:c.stock.usdgSecondary,collateral,primaryOracle:primary,guardian:c.stock.guardian,MAX_LIFETIME:45n,RECOVERY_DELAY:120n,MARKET_HEALTH_TYPEHASH};
  chain.active={client:{getCode:async()=> '0x1234',readContract:async({address,functionName})=>functionName==='decimals'?(address===c.usdg?6:18):data[functionName]}};
  assert.equal(await chain.verifyDeployment(100n),true);
  for(const key of ['executionGate','usdgPrimary','usdgSecondary','guardian','stockGuard']){
    const old=data[key];data[key]=addr(88);await assert.rejects(chain.verifyDeployment(100n),/binding mismatch/);data[key]=old;
  }
  chain.account={address:c.stock.guardian};await assert.rejects(chain.verifyDeployment(100n),/binding mismatch/);chain.account=undefined;
  chain.active.client.getCode=async({address})=>address===c.stock.usdgPrimary?'0x00':'0x1234';
  await assert.rejects(chain.verifyDeployment(100n),/runtime mismatch/);
});
