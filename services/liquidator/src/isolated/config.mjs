import { getAddress, zeroAddress, parseUnits } from 'viem';
import { configFromEnv } from '../config.mjs';
import {parseDependencyPins} from './dependencies.mjs';

export function isolatedConfigFromEnv(env = process.env) {
  const address = name => {
    if (!env[name]) throw new Error(`Required ${name}`);
    const value = getAddress(env[name]);
    if (value === zeroAddress) throw new Error(`Invalid ${name}`);
    return value;
  };
  const hash = name => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(env[name] ?? '')) throw new Error(`Required ${name}`);
    return env[name].toLowerCase();
  };
  const engine = address('ISOLATED_ENGINE_ADDRESS');
  const engineHash = hash('ISOLATED_ENGINE_CODE_HASH');
  // Explicit engine binding; never fall back to the stock vault. Registry reads
  // don't require event backfill; the base config's cursor is unused here.
  const base = configFromEnv({...env, KEEPER_VAULT_ADDRESS: engine, KEEPER_START_BLOCK: '1', KEEPER_VAULT_CODE_HASH: engineHash});
  const marketKind=env.ISOLATED_MARKET_KIND??'generic';
  if(!['generic','stock'].includes(marketKind))throw new Error('Invalid isolated market kind');
  if((marketKind==='stock')!==Boolean(base.executionGate))throw new Error('Stock markets require explicit execution liveness configuration');
  const stock=marketKind==='stock'?{
    guardian:address('STOCK_GUARDIAN_ADDRESS'),
    usdgPrimary:address('STOCK_USDG_PRIMARY_ORACLE'),usdgSecondary:address('STOCK_USDG_SECONDARY_ORACLE'),
    executionGateCodeHash:hash('STOCK_EXECUTION_GATE_CODE_HASH'),usdgCodeHash:hash('STOCK_USDG_CODE_HASH'),
    usdgPrimaryCodeHash:hash('STOCK_USDG_PRIMARY_CODE_HASH'),usdgSecondaryCodeHash:hash('STOCK_USDG_SECONDARY_CODE_HASH'),
  }:undefined;
  if (env.KEEPER_COLLATERAL_RECIPIENT) throw new Error('Isolated engine delivers collateral only to its liquidator');
  const pool = address('ISOLATED_POOL_ADDRESS');
  const collateral = address('ISOLATED_COLLATERAL_ADDRESS');
  const primary = address('ISOLATED_PRIMARY_ORACLE');
  const secondary = address('ISOLATED_SECONDARY_ORACLE');
  if (new Set([engine,pool,collateral,base.usdg,primary,secondary].map(x=>x.toLowerCase())).size !== 6) {
    throw new Error('Overlapping isolated deployment addresses');
  }
  if(stock){
    const addresses=[engine,pool,collateral,base.usdg,primary,secondary,base.executionGate,stock.usdgPrimary,stock.usdgSecondary];
    if(new Set(addresses.map(x=>x.toLowerCase())).size!==addresses.length)throw new Error('Overlapping stock dependencies');
    const u=new URL(base.livenessUrl);
    if(u.username||u.password||u.search||u.hash||!['https:','http:'].includes(u.protocol))throw new Error('Invalid stock liveness endpoint');
    stock.dependencies=parseDependencyPins(env.STOCK_DEPENDENCIES_JSON,{collateral,usdg:base.usdg,primary,usdgPrimary:stock.usdgPrimary},
      {required:env.NODE_ENV==='production'&&base.mode==='execute'});
  }
  const slippageBps = Number(env.ISOLATED_COLLATERAL_SLIPPAGE_BPS ?? '100');
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) throw new Error('Invalid collateral slippage');
  if (env.ISOLATED_ALLOW_RETAINED_COLLATERAL && !['true','false'].includes(env.ISOLATED_ALLOW_RETAINED_COLLATERAL)) {
    throw new Error('Invalid retained collateral policy');
  }
  if (Boolean(env.ISOLATED_EXIT_ADDRESS)!==Boolean(env.ISOLATED_EXIT_CODE_HASH)) throw new Error('Exit requires address and runtime hash');
  const executor=env.ISOLATED_EXIT_ADDRESS ? address('ISOLATED_EXIT_ADDRESS') : undefined;
  if (executor && [engine,pool,collateral,base.usdg,primary,secondary].some(a=>a.toLowerCase()===executor.toLowerCase())) throw new Error('Overlapping exit address');
  const profitText=env.ISOLATED_MIN_PROFIT_USDG ?? '1';
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(profitText)) throw new Error('Invalid minimum USDG profit');
  const minProfit=parseUnits(profitText,6);
  if (minProfit<=0n) throw new Error('Positive minimum profit required');
  const profitBpsText=env.ISOLATED_MIN_PROFIT_BPS??'0';
  if(!/^(?:0|[1-9][0-9]{0,4})$/.test(profitBpsText)||Number(profitBpsText)>10000)throw new Error('Invalid minimum profit basis points');
  const minProfitBps=Number(profitBpsText);
  return {...base, pool, collateral, primary, secondary, marketKind, stock,
    poolCodeHash: hash('ISOLATED_POOL_CODE_HASH'), collateralCodeHash: hash('ISOLATED_COLLATERAL_CODE_HASH'),
    primaryCodeHash: hash('ISOLATED_PRIMARY_CODE_HASH'), secondaryCodeHash: hash('ISOLATED_SECONDARY_CODE_HASH'),
    slippageBps, retainCollateral: env.ISOLATED_ALLOW_RETAINED_COLLATERAL === 'true',
    executor, executorCodeHash:executor ? hash('ISOLATED_EXIT_CODE_HASH') : undefined, minProfit, minProfitBps,
    dataDir: env.KEEPER_DATA_DIR ?? './isolated-data',
  };
}
