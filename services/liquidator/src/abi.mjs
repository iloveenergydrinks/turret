import { parseAbi } from 'viem';

export const vaultAbi = parseAbi([
  'function usdg() view returns (address)',
  'function usdgTo18Scale() view returns (uint256)',
  'function oracleStaleness() view returns (uint256)',
  'function originationFeeBps() view returns (uint16)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function totalDebt() view returns (uint256)',
  'function globalDebtCeiling() view returns (uint256)',
  'function executionGate() view returns (address)',
  'function availableLiquidity() view returns (uint256)',
  'function collateralCount() view returns (uint256)',
  'function collateralAt(uint256) view returns (address)',
  'function marketDebt(address) view returns (uint256)',
  'function markets(address) view returns (address primaryOracle, address secondaryOracle, uint128 debtCeiling, uint16 maxLtvBps, uint16 liquidationLtvBps, uint16 liquidationBonusBps, uint16 maxOracleDeviationBps, uint8 primaryOracleDecimals, uint8 secondaryOracleDecimals, bool enabled)',
  'function positions(address,address) view returns (uint128 collateral,uint128 debt)',
  'function price(address) view returns (uint256)',
  'function liquidate(address collateral,address borrower,uint256 maxRepay,address recipient) returns (uint256 repaid,uint256 collateralSeized)',
  'function liquidateChecked(address collateral,address borrower,uint256 maxRepay,address recipient,bytes proof) returns (uint256 repaid,uint256 collateralSeized)',
  'event CollateralDeposited(address indexed collateral,address indexed borrower,uint256 amount)',
  'event CollateralWithdrawn(address indexed collateral,address indexed borrower,address recipient,uint256 amount)',
  'event Borrowed(address indexed collateral,address indexed borrower,uint256 amount,uint256 fee,uint256 debt)',
  'event Repaid(address indexed collateral,address indexed borrower,address payer,uint256 amount,uint256 debt)',
  'event Liquidated(address indexed collateral,address indexed borrower,address indexed liquidator,uint256 repaid,uint256 collateralSeized)',
  'event BadDebtWrittenOff(address indexed collateral,address indexed borrower,uint256 amount)',
  'error InvalidPrice()', 'error StalePrice()', 'error PriceDisagreement(uint256 primary,uint256 independent)',
  'error MarketClosed()', 'error RecoveryPending()', 'error CorporateActionPending()',
  'error PriceQuarantined()', 'error HealthExpired()', 'error InvalidHealth()',
  'error LivenessExpired()', 'error InvalidLiveness()',
  'error PositionIsHealthy()', 'error ZeroAmount()', 'error OracleUnavailable()',
  'error OracleMismatch(uint256 primaryPrice,uint256 secondaryPrice)', 'error StockTokenPaused()',
]);
// Every debt increase emits Borrowed. Deposit-only wallets cannot require
// liquidation; indexing them would let dust deposits grow the scan indefinitely.
export const positionEvents = vaultAbi.filter(x => x.type === 'event' && x.name === 'Borrowed');
export const tokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function oraclePaused() view returns (bool)',
]);
export const oracleAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
]);
export function marketFromTuple(address, x) {
  const keys = ['primaryOracle','secondaryOracle','debtCeiling','maxLtvBps','liquidationLtvBps','liquidationBonusBps','maxOracleDeviationBps','primaryOracleDecimals','secondaryOracleDecimals','enabled'];
  return { address: address.toLowerCase(), ...Object.fromEntries(keys.map((k, i) => [k, x[i]])) };
}
