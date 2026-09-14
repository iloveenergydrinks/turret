const BPS = 10000n;
const WAD = 10n ** 18n;
const SCALE = 10n ** 12n;
const ceil = (a, b) => (a + b - 1n) / b;

// Same nested integer floors as DockyardUSDGCreditVault._isSafe.
// Threshold warnings use remaining PRICE decline, not percentage points of LTV.
export function positionHealth({ collateral, debt, price, liquidationLtvBps }) {
  if (debt === 0n) return { status: "no-debt", ltvBps: 0n, bufferBps: null, liquidationPrice: null };
  if (price == null || price <= 0n || liquidationLtvBps <= 0n || liquidationLtvBps >= BPS) {
    return { status: "unknown", ltvBps: null, bufferBps: null, liquidationPrice: null };
  }
  if (collateral === 0n) return { status: "eligible", ltvBps: null, bufferBps: 0n, liquidationPrice: null };
  const value = collateral * price / WAD;
  const debt18 = debt * SCALE;
  const safePrice = ceil(ceil(debt18 * BPS, liquidationLtvBps) * WAD, collateral);
  const eligible = debt18 > value * liquidationLtvBps / BPS;
  const bufferBps = price > safePrice ? (price - safePrice) * BPS / price : 0n;
  return {
    status: eligible ? "eligible" : bufferBps <= 300n ? "critical" : bufferBps <= 1000n ? "warning" : "healthy",
    ltvBps: value > 0n ? ceil(debt18 * BPS, value) : null,
    bufferBps,
    liquidationPrice: safePrice,
  };
}
