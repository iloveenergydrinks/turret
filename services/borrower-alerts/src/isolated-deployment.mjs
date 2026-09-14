import { getAddress, zeroAddress } from 'viem';

export function isolatedAlertsDeployment(env=process.env) {
  const address=name=>{
    if (!env[name]) throw new Error(`Missing ${name}`);
    const value=getAddress(env[name]);
    if (value===zeroAddress) throw new Error(`Invalid ${name}`);
    return value;
  };
  const hash=name=>{
    if (!/^0x[0-9a-f]{64}$/i.test(env[name] ?? '')) throw new Error(`Missing ${name}`);
    return env[name].toLowerCase();
  };
  const start=env.ALERTS_START_BLOCK;
  if (!/^[1-9][0-9]*$/.test(start ?? '') || !Number.isSafeInteger(Number(start))) throw new Error('Explicit deployment start block required');
  const d={kind:'isolated',vault:address('ALERTS_VAULT_ADDRESS'),codeHash:hash('ALERTS_VAULT_CODE_HASH'),
    pool:address('ALERTS_POOL_ADDRESS'),poolCodeHash:hash('ALERTS_POOL_CODE_HASH'),
    collateral:address('ALERTS_COLLATERAL_ADDRESS'),collateralCodeHash:hash('ALERTS_COLLATERAL_CODE_HASH'),startBlock:BigInt(start)};
  if (new Set([d.vault,d.pool,d.collateral].map(a=>a.toLowerCase())).size!==3) throw new Error('Overlapping isolated addresses');
  const kind=env.ALERTS_ISOLATED_MARKET_KIND??'generic';
  if(!['generic','stock'].includes(kind))throw new Error('Invalid isolated alert market kind');
  const stockFields=['ALERTS_EXECUTION_GATE','ALERTS_EXECUTION_GATE_CODE_HASH','ALERTS_LIVENESS_URL'];
  if(kind==='generic'&&stockFields.some(k=>env[k]))throw new Error('Stock alert configuration requires explicit stock mode');
  if(kind==='stock'){
    const gate=address('ALERTS_EXECUTION_GATE'),gateCodeHash=hash('ALERTS_EXECUTION_GATE_CODE_HASH');
    const url=new URL(env.ALERTS_LIVENESS_URL);
    if((url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))
      ||url.username||url.password||url.search||url.hash)throw new Error('Invalid stock alert liveness URL');
    if([d.vault,d.pool,d.collateral].some(a=>a.toLowerCase()===gate.toLowerCase()))throw new Error('Overlapping stock alert gate');
    d.stock={executionGate:gate,executionGateCodeHash:gateCodeHash,livenessUrl:url.toString()};
  }
  return d;
}

export function bindIsolatedAlertsDeployment(store,d) {
  const identity={kind:'isolated',vault:d.vault.toLowerCase(),codeHash:d.codeHash,
    pool:d.pool.toLowerCase(),poolCodeHash:d.poolCodeHash,collateral:d.collateral.toLowerCase(),
    collateralCodeHash:d.collateralCodeHash,startBlock:String(d.startBlock),
    ...(d.stock?{stock:{executionGate:d.stock.executionGate.toLowerCase(),executionGateCodeHash:d.stock.executionGateCodeHash}}:{})};
  const previous=store.get('system','deployment');
  if (previous && JSON.stringify(previous)!==JSON.stringify(identity)) throw new Error('Isolated alert database deployment mismatch');
  if (!previous && ['subscription','pending','session','challenge','risk','transaction','cursor','outbox'].some(kind=>store.all(kind).length)) {
    throw new Error('Use a new isolated alert database; existing consent cannot be reassigned');
  }
  store.put('system','deployment',identity);
}
