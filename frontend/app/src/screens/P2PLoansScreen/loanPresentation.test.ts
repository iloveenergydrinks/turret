import { expect, test } from "vitest";
import type { Deployment, Loan } from "../../p2p/client";
import { displayDate, fixedInterestPercent, formatAmount, GRACE, loanState, parseAmount, sortOffers, type Offer } from "./loanPresentation";

test("keeps exact collateral and USDG precision and rejects excess fractional units", () => {
  expect(parseAmount("1500.000001", 6)).toBe(1_500_000_001n);
  expect(formatAmount(parseAmount("5.000000000000000001", 18), 18)).toBe("5.000000000000000001");
  expect(parseAmount("0", 6)).toBe(0n);
  expect(() => parseAmount("0.0000001", 6)).toThrow(/decimal places/);
  expect(() => parseAmount("-1", 6)).toThrow();
});
test("does not accept values beyond the token integer range", () => {
  expect(() => parseAmount((2n ** 256n).toString(), 0)).toThrow(/too large/);
  expect(parseAmount((2n ** 256n - 1n).toString(), 0)).toBe(2n ** 256n - 1n);
});
test("shows repayment grace at the inclusive final deadline and default only afterward", () => {
  const loan = { status: "active", dueAt: 2_000_000_000 } as Loan;
  expect(loanState(loan, loan.dueAt)).toBe("Active loan");
  expect(loanState(loan, loan.dueAt + GRACE)).toBe("Grace period · repayment due");
  expect(loanState(loan, loan.dueAt + GRACE + 1)).toBe("Default · collateral claimable");
});
test("unrepresentable dates cannot crash the loan screen", () => {
  expect(displayDate(Number.POSITIVE_INFINITY)).toBe("Date unavailable");
  expect(displayDate(9_000_000_000_000)).toBe("Date unavailable");
});

const address = (digit: string) => `0x${digit.repeat(40)}` as const;
const market: Deployment = {
  chainId: 4663, chainName: "Robinhood", rpcUrl: "/api/p2p-rpc", address: address("1"),
  loanToken: address("2"), collateralToken: address("3"), loanSymbol: "USDG", collateralSymbol: "SLV",
  loanDecimals: 6, collateralDecimals: 18, version: 2, runtimeHash: `0x${"0".repeat(64)}`, startBlock: "1",
};
function offer(id: bigint, terms: Partial<Loan> = {}, deployment: Partial<Deployment> = {}): Offer {
  return { market: { ...market, ...deployment }, loan: {
    id, isPublic: true, createdAt: 1_800_000_000, lender: address("4"), borrower: address("0"),
    principal: 100_000_000n, collateral: 5n * 10n ** 18n, interest: 5_000_000n,
    durationDays: 7, expiresAt: 1_800_100_000, dueAt: 0, status: "open", ...terms,
  } };
}
const ids = (offers: Offer[]) => offers.map(({ loan }) => loan.id);

test("amount sorts distinguish adjacent uint256 values in both directions without mutating the feed", () => {
  const high = 2n ** 256n - 1n;
  const original = [offer(1n, { principal: high }), offer(2n, { principal: high - 1n }), offer(3n, { principal: 1n })];
  expect(ids(sortOffers(original, "amount"))).toEqual([3n, 2n, 1n]);
  expect(ids(sortOffers(original, "amount-desc"))).toEqual([1n, 2n, 3n]);
  expect(ids(original)).toEqual([1n, 2n, 3n]);
});

test("rate sorting compares total interest ratios, not absolute fees or rounded percentages", () => {
  const original = [
    offer(1n, { principal: 3n, interest: 1n }),
    offer(2n, { principal: 10n ** 18n, interest: 333_333_333_333_333_333n }),
    offer(3n, { principal: 100n, interest: 0n }),
    offer(4n, { principal: 100n, interest: 150n }),
  ];
  expect(fixedInterestPercent(original[0]!.loan)).toBe(fixedInterestPercent(original[1]!.loan));
  expect(ids(sortOffers(original, "rate"))).toEqual([3n, 2n, 1n, 4n]);
  expect(ids(sortOffers(original, "rate-desc"))).toEqual([4n, 1n, 2n, 3n]);
  expect(ids(sortOffers(original, "interest"))).toEqual([3n, 1n, 4n, 2n]);
});

test("rate cross-products remain exact beyond uint256 and Number ranges", () => {
  const huge = 2n ** 240n;
  const original = [offer(1n, { principal: huge, interest: huge - 1n }), offer(2n, { principal: huge, interest: huge - 2n })];
  expect(ids(sortOffers(original, "rate"))).toEqual([2n, 1n]);
  expect(ids(sortOffers(original, "rate-desc"))).toEqual([1n, 2n]);
});

test("equal rate ties are deterministic across input order, different principals, markets, and IDs", () => {
  const original = [
    offer(900n, { principal: 100n, interest: 10n }, { address: address("b") }),
    offer(2n, { principal: 200n, interest: 20n }, { address: address("a") }),
    offer(3n, { principal: 30n, interest: 3n }, { address: address("a") }),
  ];
  expect(ids(sortOffers(original, "rate"))).toEqual([3n, 2n, 900n]);
  expect(ids(sortOffers([...original].reverse(), "rate-desc"))).toEqual([3n, 2n, 900n]);
});

test("newest ranks actual timestamps before unknown legacy dates and never ranks global IDs as chronology", () => {
  const original = [
    offer(10_000n, { createdAt: 0 }, { legacy: true, version: 1 }),
    offer(999n, { createdAt: 1_800_000_000 }, { address: address("b") }),
    offer(1n, { createdAt: 1_800_000_001 }, { address: address("c") }),
    offer(2n, { createdAt: 1_800_000_000 }, { address: address("a") }),
    offer(3n, { createdAt: 1_800_000_000 }, { address: address("a") }),
  ];
  expect(ids(sortOffers(original, "newest"))).toEqual([1n, 3n, 2n, 999n, 10_000n]);
  expect(ids(sortOffers([...original].reverse(), "unknown-key"))).toEqual([1n, 3n, 2n, 999n, 10_000n]);
});

test("duration and expiry sort by their own terms, not principal or offer ID", () => {
  const original = [
    offer(1n, { durationDays: 40, expiresAt: 300 }),
    offer(2n, { durationDays: 1, expiresAt: 200 }),
    offer(3n, { durationDays: 7, expiresAt: 100 }),
  ];
  expect(ids(sortOffers(original, "duration"))).toEqual([2n, 3n, 1n]);
  expect(ids(sortOffers(original, "duration-desc"))).toEqual([1n, 3n, 2n]);
  expect(ids(sortOffers(original, "expiry"))).toEqual([3n, 2n, 1n]);
});

test("fixed interest percentages preserve zero, small positive fees, exact units, and arbitrary large rates", () => {
  expect(fixedInterestPercent({ principal: 100n, interest: 0n })).toBe("0%");
  expect(fixedInterestPercent({ principal: 10_001n, interest: 1n })).toBe("<0.01%");
  expect(fixedInterestPercent({ principal: 10_000n, interest: 1n })).toBe("0.01%");
  expect(fixedInterestPercent({ principal: 3n, interest: 1n })).toBe("33.33%");
  expect(fixedInterestPercent({ principal: 1_000n, interest: 125n })).toBe("12.5%");
  expect(fixedInterestPercent({ principal: 1n, interest: 2n ** 255n })).toBe(`${2n ** 255n * 100n}%`);
});

test("invalid rates display unavailable and sort behind valid terms in either direction", () => {
  const original = [offer(1n, { principal: 0n }), offer(2n, { interest: -1n }), offer(3n)];
  expect(fixedInterestPercent(original[0]!.loan)).toBe("—");
  expect(fixedInterestPercent(original[1]!.loan)).toBe("—");
  expect(ids(sortOffers(original, "rate"))).toEqual([3n, 2n, 1n]);
  expect(ids(sortOffers(original, "rate-desc"))).toEqual([3n, 2n, 1n]);
});
