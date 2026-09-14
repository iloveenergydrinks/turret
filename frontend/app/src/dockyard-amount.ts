import { parseUnits } from "viem";
export function positiveAmount(value: string, decimals: number): bigint {
  const input = value.trim();
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(input)) return 0n;
  try {
    const amount = parseUnits(input, decimals);
    return amount > 0n ? amount : 0n;
  } catch {
    return 0n;
  }
}
