import type { Address } from "viem";
import type { Loan } from "../../p2p/client";
import { sameAddress } from "./loanPresentation";

/** Strict UTC input: datetime-local's normal browser timezone conversion is intentionally not used. */
export function parseUtcInput(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("Enter a valid UTC date and time.");
  const milliseconds = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 16) !== value) {
    throw new Error("Enter a valid UTC date and time.");
  }
  return milliseconds / 1000;
}

/** Credits are chosen only from this manager's loaded loans and this wallet's entitlement. */
export function planCreditRepayment(loans: readonly Loan[], account: Address, target: bigint, total: bigint) {
  let remaining = total;
  const sourceIds: bigint[] = [], sourceAmounts: bigint[] = [];
  const seen = new Set<bigint>();
  for (const loan of [...loans].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (remaining <= 0n || sourceIds.length === 16) break;
    const credit = loan.loanCredits?.USDG;
    if (loan.id === target || seen.has(loan.id) || !credit || !sameAddress(credit.beneficiary, account)
      || credit.available <= 0n || credit.nominal <= 0n) continue;
    seen.add(loan.id);
    const available = credit.available < credit.nominal ? credit.available : credit.nominal;
    const amount = available < remaining ? available : remaining;
    sourceIds.push(loan.id); sourceAmounts.push(amount); remaining -= amount;
  }
  return { sourceIds, sourceAmounts, walletAmount: remaining, creditAmount: total - remaining };
}
