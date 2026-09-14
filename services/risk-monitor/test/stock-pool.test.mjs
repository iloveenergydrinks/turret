import test from 'node:test';
import assert from 'node:assert/strict';
import {stockPoolConfig,StockRiskChain,stockApproval} from '../src/stock-pool.mjs';
import {keeperReady} from '../src/keeper-health.mjs';
import {keccak256} from '../src/deps.mjs';
import {MARKET_HEALTH_TYPEHASH} from '../../liquidator/src/isolated/abi.mjs';

const address=n=>`0x${n.toString(16).padStart(40,'0')}`,hash=keccak256('0x1234');
const manifest={kind:'stock-pool',chainId:4663,vault:address(1),pool:address(2),vaultCodeHash:hash,poolCodeHash:hash,
 usdg:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',usdgCodeHash:hash,executionGate:address(6),executionGateCodeHash:hash,
 usdgPrimary:address(7),usdgSecondary:address(8),usdgPrimaryCodeHash:hash,usdgSecondaryCodeHash:hash,
 owner:address(9),guardian:address(10),keeper:address(11),markets:[{symbol:'AAPL',collateral:address(3),primaryOracle:address(4),adapter:address(5),
 collateralCodeHash:hash,primaryCodeHash:hash,adapterCodeHash:hash,maxPriceAgeSeconds:300}]};
const env={KEEPER_RPC_URL:'http://127.0.0.1:1',KEEPER_LIVENESS_URL:'http://127.0.0.1:2/liveness'};
test('stock monitor configuration requires the complete isolated deployment, USDG pins and distinct roles',()=>{
 const c=stockPoolConfig(manifest,env);assert.equal(c.vault,manifest.vault);assert.equal(c.stockPriceAgeSeconds,300);
 for(const key of ['vault','pool','vaultCodeHash','poolCodeHash','executionGate','executionGateCodeHash','usdg','usdgCodeHash',
  'usdgPrimary','usdgSecondary','usdgPrimaryCodeHash','usdgSecondaryCodeHash','owner','guardian','keeper']){
  assert.throws(()=>stockPoolConfig({...manifest,[key]:undefined},env),key);
 }
 for(const patch of [{kind:'chainlink-guarded-pilot'},{chainId:1},{markets:[]},{markets:[...manifest.markets,...manifest.markets]},
  {keeper:manifest.guardian},{owner:manifest.keeper},{usdgPrimary:manifest.usdgSecondary},{usdg:address(19)}])assert.throws(()=>stockPoolConfig({...manifest,...patch},env));
 for(const patch of [{symbol:'PONS'},{symbol:'CASHCAT'},{collateralCodeHash:undefined},{primaryCodeHash:undefined},{maxPriceAgeSeconds:undefined},
  {maxPriceAgeSeconds:86401},{maxPriceAgeSeconds:0}])assert.throws(()=>stockPoolConfig({...manifest,markets:[{...manifest.markets[0],...patch}]},env));
});
test('stock monitor runtime verification accepts only its guardian and exact engine, pool and feed bindings',async()=>{
 const c=stockPoolConfig(manifest,env),chain=new StockRiskChain(c);
 const values={usdg:c.usdg,collateralToken:c.collateral,pool:c.pool,primary:c.primary,secondary:c.secondary,owner:manifest.owner,
  MAX_ACTIVE_POSITIONS:64n,asset:c.usdg,creditEngine:c.vault,executionGate:c.executionGate,stockGuard:c.secondary,
  usdgPrimary:c.stock.usdgPrimary,usdgSecondary:c.stock.usdgSecondary,collateral:c.collateral,primaryOracle:c.primary,
  guardian:manifest.guardian,MAX_LIFETIME:45n,RECOVERY_DELAY:120n,MAX_PRICE_AGE:300n,MARKET_HEALTH_TYPEHASH};
 chain.active.client={getCode:async()=> '0x1234',readContract:async({address:a,functionName,blockNumber})=>{
  assert.equal(blockNumber,123n);return functionName==='decimals'?(a===c.usdg?6:18):values[functionName];
 }};
 chain.account={address:manifest.guardian};await chain.verifyDeployment(123n);
 // Verify the real shared binding path checks storage behind unchanged proxy code.
 c.stock.dependencies=[{address:c.usdg,kind:'implementation',implementation:address(30),implementationCodeHash:hash}];
 chain.active.client.getStorageAt=async({blockNumber})=>{
  assert.equal(blockNumber,123n);return '0x'+'0'.repeat(24)+address(30).slice(2);
 };
 await chain.verifyDeployment(123n);
 c.stock.dependencies[0].implementation=address(31);
 await assert.rejects(chain.verifyDeployment(123n),{name:'StockDependencyChanged'});
 c.stock.dependencies[0].implementation=address(30);
 for(const signer of [manifest.owner,manifest.keeper,address(20)]){
  chain.account={address:signer};await assert.rejects(chain.verifyDeployment(123n));
 }
 chain.account={address:manifest.guardian};
 for(const field of ['owner','pool','creditEngine','guardian','stockGuard','usdgPrimary','executionGate','primaryOracle']){
  const before=values[field];values[field]=address(21);await assert.rejects(chain.verifyDeployment(123n),field);values[field]=before;
 }
 values.MAX_PRICE_AGE=301n;await assert.rejects(chain.verifyDeployment(123n),/StockGuardAgeMismatch/);values.MAX_PRICE_AGE=300n;
 chain.active.client.getCode=async()=> '0xabcd';await assert.rejects(chain.verifyDeployment(123n),/runtime mismatch/);
});
test('stock admission rejects a pilot keeper and any wrong or stale pool identity',()=>{
 const now=Date.now(),s={chainId:4663,marketKind:'stock',engine:manifest.vault,pool:manifest.pool,poolCodeHash:hash,
  collateral:manifest.markets[0].collateral,executionGate:manifest.executionGate,mode:'execute',reconciled:true,
  codeHash:hash,account:manifest.keeper,checkedAt:now};
 const healthy={operational:true,lastError:null,snapshot:s};assert.equal(keeperReady(healthy,manifest,now),true);
 for(const patch of [{marketKind:'generic'},{engine:undefined,vault:manifest.vault},{pool:address(20)},{poolCodeHash:'0xwrong'},
  {collateral:address(20)},{executionGate:address(20)},{account:manifest.guardian},{checkedAt:now-30001}]){
  assert.equal(keeperReady({...healthy,snapshot:{...s,...patch}},manifest,now),false);
 }
 assert.equal(keeperReady({...healthy,operational:false},manifest,now),false);
 assert.equal(keeperReady(undefined,manifest,now),false);
});
test('stock response carries separately encoded proofs, exact deployment identity and the shorter expiry',()=>{
 const result=stockApproval(manifest,{encoded:'0x1234',validUntil:100},{encoded:'0x5678',validUntil:95});
 assert.equal(result.kind,'stock-pool');assert.equal(result.engine,manifest.vault);assert.equal(result.pool,manifest.pool);
 assert.equal(result.adapter,manifest.markets[0].adapter);assert.equal(result.usdgPrimary,manifest.usdgPrimary);
 assert.equal(result.health,'0x1234');assert.equal(result.liveness,'0x5678');assert.equal(result.validUntil,95);
 assert.equal(result.encoded,undefined);
});
