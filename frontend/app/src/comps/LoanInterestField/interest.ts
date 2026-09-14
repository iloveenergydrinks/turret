import { formatUnits } from "viem";

export const MAX_AMOUNT = (1n << 256n) - 1n;
const RATE_SCALE = 1_000_000n;
export type InterestUnit = "USDG" | "%";
export type InterestInput =
  | { unit: "USDG"; value: string }
  | { unit: "%"; value: string; exactRate?: { principal: bigint; interest: bigint } };

/** Reject excess precision rather than letting a token parser round signed terms. */
export function exactAmount(value: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || value.length > 335
    || !/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  if (whole.length > 78 || fraction.length > decimals) return null;
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return amount <= MAX_AMOUNT ? amount : null;
}

export function termPercent(principal: bigint, interest: bigint): string {
  if (principal <= 0n || interest < 0n) return "—";
  const numerator = interest * 100n * RATE_SCALE;
  const value = numerator / principal;
  if (interest > 0n && value === 0n) return "<0.000001%";
  return `${numerator % principal ? "≈ " : ""}${formatUnits(value, 6)}%`;
}

export function resolveInterest(principalText: string, decimals: number, input: InterestInput) {
  const principal = exactAmount(principalText, decimals);
  let amount: bigint | null = null;
  let rounded = false;
  let error = "";
  if (input.unit === "USDG") {
    amount = exactAmount(input.value, decimals);
    if (amount === null) error = `Enter an interest amount with up to ${decimals} decimal places, or 0 for no interest.`;
  } else {
    const percent = exactAmount(input.value, 6);
    if (percent === null) error = "Enter a percentage with up to 6 decimal places, or 0 for no interest.";
    else if (principal === null || principal <= 0n) error = "Enter a positive loan amount to calculate interest.";
    else {
      const numerator = principal * (input.exactRate?.interest ?? percent);
      const denominator = input.exactRate?.principal ?? 100n * RATE_SCALE;
      amount = numerator / denominator;
      rounded = numerator % denominator !== 0n;
      if (numerator > 0n && amount === 0n) {
        error = "This interest is smaller than one USDG unit of precision. Increase the percentage or enter 0 for no interest.";
      }
    }
  }
  if (amount !== null && (amount > MAX_AMOUNT || (principal !== null && principal + amount > MAX_AMOUNT))) {
    error = "Total repayment is too large. Reduce the loan amount or interest.";
  }
  const valid = !error && amount !== null;
  return {
    amount: valid ? amount : null,
    interest: valid ? formatUnits(amount!, decimals) : "",
    principal,
    total: valid && principal !== null && principal > 0n ? principal + amount! : null,
    percent: valid && principal !== null ? termPercent(principal, amount!) : "—",
    rounded,
    error,
  };
}

/** Changing units preserves the exact amount, even for repeating percentages such as 1/3. */
export function switchInterestUnit(input: InterestInput, unit: InterestUnit, principal: string, decimals: number): InterestInput {
  if (unit === input.unit) return input;
  const resolved = resolveInterest(principal, decimals, input);
  if (unit === "USDG") return { unit, value: resolved.interest };
  if (resolved.amount !== null && resolved.principal !== null && resolved.principal > 0n) {
    return { unit, value: formatUnits(resolved.amount * 100n * RATE_SCALE / resolved.principal, 6),
      exactRate: { principal: resolved.principal, interest: resolved.amount } };
  }
  return { unit, value: resolved.amount === 0n ? "0" : "" };
}
