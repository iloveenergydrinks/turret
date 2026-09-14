import { describe, expect, test } from "vitest";
import { exactAmount, MAX_AMOUNT, resolveInterest, switchInterestUnit, termPercent, type InterestInput } from "./interest";

test("USDG and percentage produce identical contract amounts", () => {
  expect(resolveInterest("100", 6, { unit: "%", value: "5" })).toMatchObject({ amount: 5_000_000n, total: 105_000_000n, error: "" });
  expect(resolveInterest("100", 6, { unit: "USDG", value: "5" })).toMatchObject({ amount: 5_000_000n, total: 105_000_000n, error: "" });
});
test("percentage follows principal, USDG remains a fixed amount", () => {
  expect(resolveInterest("200", 6, { unit: "%", value: "5" }).amount).toBe(10_000_000n);
  expect(resolveInterest("200", 6, { unit: "USDG", value: "5" }).amount).toBe(5_000_000n);
});
test("switching repeating percentages never changes the agreed amount", () => {
  let input: InterestInput = { unit: "USDG", value: "1" };
  for (let n = 0; n < 20; n++) {
    input = switchInterestUnit(input, "%", "3", 6);
    expect(input.value).toBe("33.333333");
    expect(resolveInterest("3", 6, input).amount).toBe(1_000_000n);
    expect(resolveInterest("6", 6, input).amount).toBe(2_000_000n);
    input = switchInterestUnit(input, "USDG", "3", 6);
    expect(input.value).toBe("1");
  }
});
test("fractional fees floor once in integer token units and disclose rounding", () => {
  expect(resolveInterest("1.000001", 6, { unit: "%", value: "12.51" })).toMatchObject({ amount: 125100n, rounded: true, error: "" });
  expect(resolveInterest("100", 18, { unit: "%", value: "0.000001" }).amount).toBe(1_000_000_000_000n);
  expect(resolveInterest("100", 0, { unit: "%", value: "5.5" })).toMatchObject({ amount: 5n, rounded: true });
});
test("positive interest cannot silently become a zero-interest loan", () => {
  expect(resolveInterest("0.000001", 6, { unit: "%", value: "1" })).toMatchObject({ amount: null, interest: "" });
  expect(resolveInterest("0.000001", 6, { unit: "%", value: "0" }).amount).toBe(0n);
  expect(termPercent(10n ** 30n, 1n)).toBe("<0.000001%");
});
describe.each(["USDG", "%"] as const)("%s validation", unit => {
  test.each(["", "-1", "1e2", "NaN", "Infinity", "5%", "1,5", "0.0000001", "1.", " ", "9".repeat(1000)])("rejects %j without stale terms", value => {
    expect(resolveInterest("100", 6, { unit, value })).toMatchObject({ amount: null, interest: "" });
  });
  test("allows zero and rates above 100%", () => {
    expect(resolveInterest("100", 6, { unit, value: "0" }).error).toBe("");
    expect(resolveInterest("100", 6, { unit, value: "150" }).amount).toBe(150_000_000n);
  });
});
test.each(["", "0", "-1", "1e2", "0.0000001"])("invalid principal %j blocks percentage calculation", principal => {
  expect(resolveInterest(principal, 6, { unit: "%", value: "5" }).amount).toBeNull();
});
test("overflow checks cover principal, interest and their sum", () => {
  expect(exactAmount(String(MAX_AMOUNT), 0)).toBe(MAX_AMOUNT);
  expect(exactAmount(String(MAX_AMOUNT + 1n), 0)).toBeNull();
  for (const unit of ["USDG", "%"] as const) {
    expect(resolveInterest(String(MAX_AMOUNT), 0, { unit, value: "1" })).toMatchObject({ amount: null, total: null });
  }
  expect(resolveInterest("9007199254740993", 6, { unit: "%", value: "5" }).amount).toBe(450359962737049650000n);
});
