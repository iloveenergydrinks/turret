import { describe, expect, test } from "vitest";
import * as math from "./termMath";

const MAX_UINT256 = (1n << 256n) - 1n;

describe("safeAmount", () => {
  test("preserves exact token units, zero and whitespace", () => {
    expect(math.safeAmount(" 1500.000001 ", 6)).toBe(1_500_000_001n);
    expect(math.safeAmount("5.000000000000000001", 18)).toBe(5_000_000_000_000_000_001n);
    expect(math.safeAmount("0", 6)).toBe(0n);
    expect(math.safeAmount("7", 0)).toBe(7n);
  });

  test("returns null for invalid amounts, precision and uint256 overflow", () => {
    for (const value of ["", " ", "-1", "+1", "1e3", "1,000", ".5", "1.", "NaN", "Infinity"]) {
      expect(math.safeAmount(value, 6)).toBeNull();
    }
    expect(math.safeAmount("0.0000001", 6)).toBeNull();
    for (const decimals of [-1, 1.5, NaN, Infinity, 256]) expect(math.safeAmount("1", decimals)).toBeNull();
    expect(math.safeAmount(MAX_UINT256.toString(), 0)).toBe(MAX_UINT256);
    expect(math.safeAmount((MAX_UINT256 + 1n).toString(), 0)).toBeNull();
  });
});

describe("interestFromBps", () => {
  test("floors fixed interest at token precision without floating-point drift", () => {
    expect(math.interestFromBps("123.456789", 6, 125)).toBe("1.543209");
    expect(math.interestFromBps("1.000000000000000001", 18, 5000)).toBe("0.5");
    expect(math.interestFromBps("3", 0, 5000)).toBe("1");
    expect(math.interestFromBps("0.000001", 6, 1)).toBe("0");
    expect(math.interestFromBps("100", 6, 0)).toBe("0");
    expect(math.interestFromBps("0", 6, 1000)).toBe("0");
  });

  test("supports custom rates above 100 percent and large exact amounts", () => {
    expect(math.interestFromBps("100", 6, 25000)).toBe("250");
    expect(math.interestFromBps("9007199254740993.000001", 6, 10000)).toBe("9007199254740993.000001");
    expect(math.interestFromBps("10000", 0, Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(math.interestFromBps(MAX_UINT256.toString(), 0, 10000)).toBe(MAX_UINT256.toString());
    expect(math.interestFromBps(MAX_UINT256.toString(), 0, 10001)).toBeNull();
  });

  test("rejects invalid rates and amounts instead of coercing them", () => {
    for (const rate of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(math.interestFromBps("100", 6, rate)).toBeNull();
    }
    expect(math.interestFromBps("bad", 6, 100)).toBeNull();
    expect(math.interestFromBps("1.0000001", 6, 100)).toBeNull();
  });
});

describe("rateBps", () => {
  test("calculates whole basis points without imposing a slider cap", () => {
    expect(math.rateBps("100", "1.25", 6)).toBe(125);
    expect(math.rateBps("100", "250", 6)).toBe(25_000);
    expect(math.rateBps("3", "1", 0)).toBe(3333);
    expect(math.rateBps("1", "0.000001", 6)).toBe(0);
    expect(math.rateBps("1", "0", 6)).toBe(0);
  });

  test("uses bigint for large inputs and converts only a safe display result", () => {
    expect(math.rateBps(MAX_UINT256.toString(), MAX_UINT256.toString(), 0)).toBe(10_000);
    expect(math.rateBps("10000", "9007199254740991", 0)).toBe(Number.MAX_SAFE_INTEGER);
    expect(math.rateBps("10000", "9007199254740992", 0)).toBeNull();
    expect(math.rateBps("0.000001", MAX_UINT256.toString(), 0)).toBeNull();
  });

  test("rejects zero principal, negative amounts and invalid precision", () => {
    expect(math.rateBps("0", "0", 6)).toBeNull();
    expect(math.rateBps("0", "1", 6)).toBeNull();
    expect(math.rateBps("-1", "1", 6)).toBeNull();
    expect(math.rateBps("1", "-1", 6)).toBeNull();
    expect(math.rateBps("1", "0.0000001", 6)).toBeNull();
    expect(math.rateBps("1", "1", NaN)).toBeNull();
  });
});

describe("scaledCollateral", () => {
  test("scales the original anchor exactly and floors at token precision", () => {
    expect(math.scaledCollateral("1.234567", 6, 125)).toBe("1.543208");
    expect(math.scaledCollateral("2.000000000000000002", 18, 50)).toBe("1.000000000000000001");
    expect(math.scaledCollateral("3", 0, 50)).toBe("1");
    expect(math.scaledCollateral("4", 0, 25)).toBe("1");
    expect(math.scaledCollateral("4", 0, 200)).toBe("8");
    expect(math.scaledCollateral("9007199254740993.000001", 6, 100)).toBe("9007199254740993.000001");
  });

  test("keeps positive anchors at a minimum of one raw token unit", () => {
    expect(math.scaledCollateral("0.000001", 6, 25)).toBe("0.000001");
    expect(math.scaledCollateral("0.000000000000000001", 18, 25)).toBe("0.000000000000000001");
    expect(math.scaledCollateral("0.000001", 6, 200)).toBe("0.000002");
  });

  test("rejects zero anchors, invalid percentages and overflow", () => {
    expect(math.scaledCollateral("0", 6, 100)).toBeNull();
    expect(math.scaledCollateral("bad", 6, 100)).toBeNull();
    expect(math.scaledCollateral("0.0000001", 6, 100)).toBeNull();
    for (const percent of [0, 24, 201, 25.5, NaN, Infinity]) {
      expect(math.scaledCollateral("1", 6, percent)).toBeNull();
    }
    expect(math.scaledCollateral(MAX_UINT256.toString(), 0, 100)).toBe(MAX_UINT256.toString());
    expect(math.scaledCollateral(MAX_UINT256.toString(), 0, 200)).toBeNull();
  });
});

describe("ratioText", () => {
  test("accounts for both token precisions and trims up to six decimal places", () => {
    expect(math.ratioText(25_000_000n, 6, 2_000_000_000_000_000_000n, 18)).toBe("12.5");
    expect(math.ratioText(1n, 0, 3n, 0)).toBe("0.333333");
    expect(math.ratioText(2n, 0, 3n, 0)).toBe("0.666666");
    expect(math.ratioText(123_456_789n, 6, 1_000_000n, 6)).toBe("123.456789");
    expect(math.ratioText(1_000_000n, 6, 1n, 0)).toBe("1");
    expect(math.ratioText(1n, 18, 1n, 6)).toBe("<0.000001");
  });

  test("distinguishes tiny positive ratios from exact zero", () => {
    expect(math.ratioText(1n, 0, 1_000_000n, 0)).toBe("0.000001");
    expect(math.ratioText(1n, 0, 1_000_001n, 0)).toBe("<0.000001");
    expect(math.ratioText(999_999n, 18, 1n, 0)).toBe("<0.000001");
    expect(math.ratioText(0n, 18, 1n, 6)).toBe("0");
  });

  test("preserves large display-only numerators without a uint256 or Number cap", () => {
    expect(math.ratioText(9_007_199_254_740_993n, 0, 1n, 0)).toBe("9007199254740993");
    expect(math.ratioText(MAX_UINT256 * 100n, 6, MAX_UINT256, 6)).toBe("100");
    expect(math.ratioText(10n ** 100n, 18, 10n ** 90n, 6)).toBe("0.01");
    expect(math.ratioText(1n, 255, 1n, 255)).toBe("1");
  });

  test("rejects invalid signs, zero denominator and unsupported decimal precision", () => {
    expect(math.ratioText(-1n, 6, 1n, 6)).toBeNull();
    expect(math.ratioText(1n, 6, -1n, 6)).toBeNull();
    expect(math.ratioText(1n, 6, 0n, 6)).toBeNull();
    expect(math.ratioText(0n, 6, 0n, 6)).toBeNull();
    for (const decimals of [-1, 0.5, NaN, Infinity, 256]) {
      expect(math.ratioText(1n, decimals, 1n, 6)).toBeNull();
      expect(math.ratioText(1n, 6, 1n, decimals)).toBeNull();
    }
  });
});
