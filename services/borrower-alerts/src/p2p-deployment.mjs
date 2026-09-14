import { readFileSync } from 'node:fs';
import { isAddress, keccak256, toHex } from 'viem';

const address = value => typeof value === 'string' && isAddress(value, { strict: false }) && !/^0x0{40}$/i.test(value);
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
export function p2pAlertsDeployment(env = process.env) {
  if (!env.ALERTS_P2P_REGISTRY_PATH) throw new Error('Explicit P2P registry required');
  return validateP2PAlertsRegistry(JSON.parse(readFileSync(env.ALERTS_P2P_REGISTRY_PATH, 'utf8')), {
    allowLocal: env.ALERTS_P2P_ALLOW_LOCAL === 'true', confirmations: Number(env.ALERTS_P2P_CONFIRMATIONS ?? 12),
  });
}
export function validateP2PAlertsRegistry(registry, { allowLocal = false, confirmations = 12 } = {}) {
  if (!Array.isArray(registry?.markets) || !registry.markets.length || registry.markets.length > 100
    || !Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 128) throw new Error('Invalid P2P alerts registry');
  const markets = registry.markets.map(row => {
    if (!row || ![1,2,3].includes(row.version ?? 1) || !address(row.address) || !address(row.loanToken)
      || !address(row.collateralToken) || row.loanToken.toLowerCase() === row.collateralToken.toLowerCase()
      || ![4663, ...(allowLocal ? [31337] : [])].includes(row.chainId) || !/^0x[0-9a-f]{64}$/i.test(row.runtimeHash)
      || !uint(row.startBlock) || !Number.isInteger(row.loanDecimals) || row.loanDecimals < 0 || row.loanDecimals > 36
      || !Number.isInteger(row.collateralDecimals) || row.collateralDecimals < 0 || row.collateralDecimals > 36
      || !/^[a-zA-Z0-9.-]{1,24}$/.test(row.collateralSymbol ?? '') || row.loanSymbol !== 'USDG') throw new Error('Invalid registered P2P market');
    return { address: row.address.toLowerCase(), version: row.version ?? 1, chainId: row.chainId,
      loanToken: row.loanToken.toLowerCase(), collateralToken: row.collateralToken.toLowerCase(),
      runtimeHash: row.runtimeHash.toLowerCase(), startBlock: row.startBlock, loanDecimals: row.loanDecimals,
      collateralDecimals: row.collateralDecimals, collateralSymbol: row.collateralSymbol, loanSymbol: 'USDG' };
  }).sort((a,b) => a.address.localeCompare(b.address));
  if (new Set(markets.map(row => row.address)).size !== markets.length || markets.some(row => row.chainId !== markets[0].chainId)) throw new Error('Ambiguous P2P registry');
  const scope = keccak256(toHex(JSON.stringify(markets)));
  return { kind: 'p2p', vault: markets[0].address, chainId: markets[0].chainId, markets, scope, confirmations };
}
export function bindP2PAlertsDeployment(store, deployment) {
  const previous = store.get('system','deployment');
  if ((previous && (previous.kind !== 'p2p' || previous.scope !== deployment.scope))
    || (!previous && ['subscription','pending','challenge','session'].some(kind => store.all(kind).length))) {
    throw new Error('P2P market scope changed; use a separate database and obtain fresh P2P consent');
  }
  store.put('system','deployment',{kind:'p2p',scope:deployment.scope,chainId:deployment.chainId});
}
