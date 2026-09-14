import { expect, test } from "vitest";
import type { IsolatedMarketState } from "./isolated-credit";
import { displayTokenAmount, validateIsolatedForm } from "./isolated-form-validation";

const state = {
  collateral: 0n, debt: 0n, price: 250000000000000000n, borrowingPrice: 250000000000000000n,
  maxLtvBps: 4000, liquidationLtvBps: 5000, riskPaused: false, maxDeposit: 200000000n,
  cash: 200000000n, principal: 0n, debtLimit: 200000000n, minimumDebt: 10000000n,
  collateralBalance: 193018181082051540811n, cashBalance: 100000000n,
} as IsolatedMarketState;
const validate = (amount: string, extra = "193.018181082051540811", changes = {}) =>
  validateIsolatedForm({ ...state, ...changes }, "depositBorrow", amount, extra, "CASHCAT");

test("new collateral gives borrowing capacity even when the current position has none", () => {
  const result = validate("10");
  expect(result.invalid).toBe(false);
  expect(result.preview?.maxAdditional).toBe(19301818n);
  expect(result.preview?.projectedDebt).toBe(10000000n);
});
test("oversized borrowing explains the pool and collateral limits independently", () => {
  const result = validate("1000");
  expect(result.invalid).toBe(true);
  expect(result.amountErrors).toEqual(expect.arrayContaining([
    expect.stringContaining("Only 200 USDG"), expect.stringContaining("at most 19.301818 USDG"),
  ]));
});
test("borrowing capacity includes existing debt and the remaining market cap", () => {
  expect(validate("10", "193.018181082051540811", { debt: 5000000n }).preview?.maxAdditional).toBe(14301818n);
  const capped = validate("10", "193.018181082051540811", { principal: 195000000n });
  expect(capped.preview?.maxAdditional).toBe(5000000n);
  expect(capped.amountErrors.join(" ")).toContain("market can lend another 5 USDG");
});
test("minimum total debt and exact wallet balance are checked before review", () => {
  expect(validate("9").amountErrors.join(" ")).toContain("at least 10 USDG");
  expect(validate("10", "193.018181082051540812").collateralError).toContain("Your wallet holds");
  expect(validate("10").collateralError).toBe("");
});
test.each(["1e3", "-1", "0", "0.0000001", "9".repeat(90)])("invalid USDG input %s has a visible error", (input) => {
  expect(validate(input).amountErrors.length).toBeGreaterThan(0);
});
test("unavailable prices do not produce invented borrowing estimates", () => {
  expect(validate("10", "193", { borrowingPrice: null }).preview).toBeNull();
  expect(validate("10", "193", { riskPaused: true }).preview?.maxAdditional).toBe(0n);
  expect(validateIsolatedForm(null, "depositBorrow", "", "", "CASHCAT").invalid).toBe(false);
});
test("protective actions validate balances and remaining minimum debt", () => {
  const owing = { ...state, debt: 50000000n, collateral: 1000n * 10n ** 18n };
  expect(validateIsolatedForm(owing, "repay", "45", "", "CASHCAT").amountErrors.join(" ")).toContain("leave at least 10 USDG");
  expect(validateIsolatedForm(owing, "close", "49", "", "CASHCAT").amountErrors.join(" ")).toContain("will not close");
  expect(validateIsolatedForm(owing, "close", "50.01", "", "CASHCAT").invalid).toBe(false);
  expect(validateIsolatedForm(owing, "removeCollateral", "900", "", "CASHCAT").invalid).toBe(true);
  expect(validateIsolatedForm(owing, "addCollateral", "200", "", "CASHCAT").invalid).toBe(true);
});
test("display formatting truncates without changing the full-precision input", () => {
  expect(displayTokenAmount(state.collateralBalance, 18)).toBe("193.018181");
  expect(displayTokenAmount(10999999n)).toBe("10.999999");
  expect(displayTokenAmount(1n, 18)).toBe("<0.000001");
});

const cashcatLoan = { ...state, debt: 14000027n, cashBalance: 38314977n };
test("the reported CASHCAT repayment gives the usable partial limit and a full repayment choice", () => {
  const result = validateIsolatedForm(cashcatLoan, "repay", "14.000022", "", "CASHCAT");
  expect(result.invalid).toBe(true);
  expect(result.amountErrors.join(" ")).toContain("4.000027 USDG");
  expect(result.amountErrors.join(" ")).toContain("leave at least 10 USDG");
  expect(result.amountErrors.join(" ")).toContain("Repay in full");
});
test.each(["14.000027", "14.01"])("partial repayment of %s requires an explicit full repayment choice", (input) => {
  const result = validateIsolatedForm(cashcatLoan, "repay", input, "", "CASHCAT");
  expect(result.invalid).toBe(true);
  expect(result.amountErrors.join(" ")).toContain("Repay in full");
});
test("the exact partial repayment limit is valid but one micro USDG above it is rejected", () => {
  expect(validateIsolatedForm(cashcatLoan, "repay", "4.000027", "", "CASHCAT").invalid).toBe(false);
  expect(validateIsolatedForm(cashcatLoan, "repay", "4.000028", "", "CASHCAT").invalid).toBe(true);
});
test("a minimum-sized loan explains that only full repayment is available", () => {
  const result = validateIsolatedForm({ ...cashcatLoan, debt: 10000000n }, "repay", "1", "", "CASHCAT");
  expect(result.amountErrors.join(" ")).toContain("Repay in full");
  expect(result.amountErrors.join(" ")).toContain("leave at least 10 USDG");
});

test.each(['', '24', '50'])('PONS below the pool minimum gives one achievable next step for input %s', input => {
 const result = validateIsolatedForm({...state,collateralBalance:213590234000000000000n,minimumDebt:50000000n,maxLtvBps:2000,price:584116093690000000n,borrowingPrice:584116093690000000n,cash:300000000n},'depositBorrow',input,'213.590234','PONS');
 expect(result.invalid).toBe(true);
 expect(result.amountErrors).toHaveLength(1);
 expect(result.amountErrors[0]).toContain("below the pool's 50 USDG minimum");
 expect(result.amountErrors[0]).toContain('PONS in total');
 expect(result.amountErrors[0]).not.toContain('borrow less');
 expect(result.preview?.maxAdditional).toBe(0n);
});

test('the displayed minimum collateral is sufficient under contract rounding, and more collateral clears the block', () => {
 const market = {...state,collateralBalance:1000n*10n**18n,minimumDebt:50000000n,maxLtvBps:2000,price:584116093690000000n,borrowingPrice:584116093690000000n,cash:300000000n};
 const blocked=validateIsolatedForm(market,'depositBorrow','50','213.590234','PONS');
 const required=blocked.amountErrors[0].match(/at least ([\d.]+) PONS in total/)![1];
 const eligible=validateIsolatedForm(market,'depositBorrow','50',required,'PONS');
 expect(eligible.invalid).toBe(false);
 expect(eligible.preview!.collateralLimit).toBeGreaterThanOrEqual(50000000n);
 expect(validateIsolatedForm(market,'depositBorrow','50','430','PONS').invalid).toBe(false);
});
