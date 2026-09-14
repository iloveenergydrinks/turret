import {isolatedConfigFromEnv} from '../../liquidator/src/isolated/config.mjs';
import {IsolatedChain} from '../../liquidator/src/isolated/chain.mjs';
import {parseAbi} from './deps.mjs';

const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const roleAddress=value=>/^0x[0-9a-fA-F]{40}$/.test(value??'')&&!/^0x0{40}$/.test(value);

// One deployment and one dedicated keeper per monitor. A pilot manifest can
// never provide the missing pool/feed identities by fallback or inference.
export function stockPoolConfig(manifest,env){
 if(manifest.kind!=='stock-pool'||manifest.chainId!==4663||manifest.markets?.length!==1)throw new Error('InvalidStockManifest');
 if(![manifest.owner,manifest.guardian,manifest.keeper].every(roleAddress)
  ||new Set([manifest.owner,manifest.guardian,manifest.keeper].map(x=>x.toLowerCase())).size!==3)throw new Error('InvalidStockRoles');
 const m=manifest.markets[0];
 if(!['AAPL','MSFT','GOOGL','AMZN','META','NVDA','AMD','ORCL','MU','TSLA'].includes(m.symbol)
  ||!Number.isSafeInteger(m.maxPriceAgeSeconds)||m.maxPriceAgeSeconds<60||m.maxPriceAgeSeconds>86400)throw new Error('InvalidStockMarket');
 const config=isolatedConfigFromEnv({...env,
  ISOLATED_MARKET_KIND:'stock',ISOLATED_ENGINE_ADDRESS:manifest.vault,ISOLATED_ENGINE_CODE_HASH:manifest.vaultCodeHash,
  ISOLATED_POOL_ADDRESS:manifest.pool,ISOLATED_POOL_CODE_HASH:manifest.poolCodeHash,
  ISOLATED_COLLATERAL_ADDRESS:m.collateral,ISOLATED_COLLATERAL_CODE_HASH:m.collateralCodeHash,
  ISOLATED_PRIMARY_ORACLE:m.primaryOracle,ISOLATED_PRIMARY_CODE_HASH:m.primaryCodeHash,
  ISOLATED_SECONDARY_ORACLE:m.adapter,ISOLATED_SECONDARY_CODE_HASH:m.adapterCodeHash,
  KEEPER_EXECUTION_GATE:manifest.executionGate,STOCK_EXECUTION_GATE_CODE_HASH:manifest.executionGateCodeHash,
  STOCK_GUARDIAN_ADDRESS:manifest.guardian,STOCK_USDG_CODE_HASH:manifest.usdgCodeHash,
  STOCK_USDG_PRIMARY_ORACLE:manifest.usdgPrimary,STOCK_USDG_PRIMARY_CODE_HASH:manifest.usdgPrimaryCodeHash,
  STOCK_USDG_SECONDARY_ORACLE:manifest.usdgSecondary,STOCK_USDG_SECONDARY_CODE_HASH:manifest.usdgSecondaryCodeHash,
  STOCK_DEPENDENCIES_JSON:manifest.dependencies?JSON.stringify(manifest.dependencies):undefined,
  // This process quarantines guards, not collateral sales. Never inherit a
  // keeper's executor/recipient policy from a shared environment.
  ISOLATED_EXIT_ADDRESS:undefined,ISOLATED_EXIT_CODE_HASH:undefined,KEEPER_COLLATERAL_RECIPIENT:undefined,
 });
 if(!same(manifest.usdg,config.usdg))throw new Error('InvalidStockUSDG');
 return {...config,expectedOwner:manifest.owner,expectedKeeper:manifest.keeper,stockPriceAgeSeconds:m.maxPriceAgeSeconds};
}

const abi=parseAbi(['function MAX_PRICE_AGE() view returns(uint256)']);
export class StockRiskChain extends IsolatedChain {
 async verifyDeployment(blockNumber){
  const {owner,guardian}=await this.verifyBindings(blockNumber);
  if(!same(owner,this.config.expectedOwner)||!same(guardian,this.config.stock.guardian)
   ||this.account&&(!same(this.account.address,guardian)||same(this.account.address,owner)
    ||same(this.account.address,this.config.expectedKeeper)))throw new Error('StockRiskRoleMismatch');
  const age=await this.client.readContract({address:this.config.secondary,abi,functionName:'MAX_PRICE_AGE',blockNumber});
  if(age!==BigInt(this.config.stockPriceAgeSeconds))throw new Error('StockGuardAgeMismatch');
  return true;
 }
}

export function stockApproval(manifest,health,liveness){
 const m=manifest.markets[0];
 return {kind:'stock-pool',chainId:4663,engine:manifest.vault,pool:manifest.pool,collateral:m.collateral,
  adapter:m.adapter,executionGate:manifest.executionGate,usdgPrimary:manifest.usdgPrimary,usdgSecondary:manifest.usdgSecondary,
  health:health.encoded,liveness:liveness.encoded,validUntil:Math.min(health.validUntil,liveness.validUntil)};
}
