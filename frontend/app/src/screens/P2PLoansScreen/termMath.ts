import { formatAmount, parseAmount } from "./loanPresentation";

const MAX_UINT256 = (1n << 256n) - 1n;
const validDecimals = (decimals: number) => Number.isInteger(decimals) && decimals >= 0 && decimals <= 255;

export function safeAmount(text: string, decimals: number): bigint | null {
  if (!validDecimals(decimals)) return null;
  try {
    return parseAmount(text, decimals);
  } catch {
    return null;
  }
}

/** Fixed interest for the whole loan, floored to the token's smallest unit. */
export function interestFromBps(principal: string, decimals: number, bps: number): string | null {
  if (!Number.isSafeInteger(bps) || bps < 0) return null;
  const amount = safeAmount(principal, decimals);
  if (amount === null) return null;
  const interest = amount * BigInt(bps) / 10_000n;
  return interest <= MAX_UINT256 ? formatAmount(interest, decimals) : null;
}

/** Whole basis points for display; the exact interest amount remains authoritative. */
export function rateBps(principal: string, interest: string, decimals: number): number | null {
  const amount = safeAmount(principal, decimals);
  const fee = safeAmount(interest, decimals);
  if (amount === null || amount === 0n || fee === null) return null;
  const bps = fee * 10_000n / amount;
  return bps <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bps) : null;
}

/** Scale a positive collateral anchor, retaining at least one smallest token unit. */
export function scaledCollateral(anchor: string, decimals: number, percent: number): string | null {
  if (!Number.isInteger(percent) || percent < 25 || percent > 200) return null;
  const amount = safeAmount(anchor, decimals);
  if (amount === null || amount === 0n) return null;
  const scaled = amount * BigInt(percent) / 100n;
  if (scaled > MAX_UINT256) return null;
  return formatAmount(scaled === 0n ? 1n : scaled, decimals);
}

/** Quantity ratio only; no token price or collateral valuation is implied. */
export function ratioText(
  numerator: bigint,
  numeratorDecimals: number,
  denominator: bigint,
  denominatorDecimals: number,
): string | null {
  if (!validDecimals(numeratorDecimals) || !validDecimals(denominatorDecimals)
    || numerator < 0n || denominator <= 0n) return null;
  const scaled = numerator * 10n ** BigInt(denominatorDecimals) * 1_000_000n
    / (denominator * 10n ** BigInt(numeratorDecimals));
  return numerator > 0n && scaled === 0n ? "<0.000001" : formatAmount(scaled, 6);
}
