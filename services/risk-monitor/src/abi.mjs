import {parseAbi} from './deps.mjs';
export const guardAbi=parseAbi([
 'function collateral() view returns(address)','function primaryOracle() view returns(address)','function guardian() view returns(address)',
 'function primaryDecimals() view returns(uint8)','function epoch() view returns(uint64)','function recoveryAt() view returns(uint256)',
 'function MAX_PRICE_AGE() view returns(uint256)',
 'function liquidationQuarantined() view returns(bool)','function trip(bool unsafePrice)','function submitHealth(bytes encoded)',
 'function validatedPrice(bool borrowing) view returns(uint256,uint256)',
 'function health() view returns(uint80 roundId,uint64 observedAt,uint64 validUntil,uint64 sessionOpen,uint64 sessionClose,bytes32 roundHash,uint64 epoch)',
 'error InvalidConfiguration()','error InvalidPrice()','error StalePrice()','error CorporateActionPending()',
 'error HealthExpired()','error InvalidHealth()','error MarketClosed()','error RecoveryPending()','error PriceQuarantined()','error UnauthorizedGuardian()'
]);
export const primaryAbi=parseAbi(['function decimals() view returns(uint8)','function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
export const stockAbi=parseAbi(['function uiMultiplier() view returns(uint256)','function effectiveAt() view returns(uint256)','function oraclePaused() view returns(bool)']);
export const executionGateAbi=parseAbi([
 'function guardian() view returns(address)','function epoch() view returns(uint64)','function recoveryAt() view returns(uint256)',
 'function MAX_LIFETIME() view returns(uint256)','function RECOVERY_DELAY() view returns(uint256)',
 'function requireLive() view','function submitLiveness(bytes encoded)','function trip()',
 'error InvalidLiveness()','error LivenessExpired()','error RecoveryPending()'
]);
