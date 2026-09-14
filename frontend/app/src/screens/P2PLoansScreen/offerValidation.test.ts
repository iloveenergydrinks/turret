import { describe, expect, test } from "vitest";
import type { Deployment } from "../../p2p/client";
import { formatAmount, GRACE, ZERO_ADDRESS } from "./loanPresentation";
import { type OfferDraftInput, type OfferValidationContext, validateOfferDraft } from "./offerValidation";

const address = (digit: string) => `0x${digit.repeat(40)}` as const;
const maxUint256 = 2n ** 256n - 1n;
const market: Deployment = {
  chainId: 4663,
  chainName: "Robinhood",
  rpcUrl: "/api/p2p-rpc",
  address: address("a"),
  loanToken: address("b"),
  collateralToken: address("c"),
  loanSymbol: "USDG",
  collateralSymbol: "SLV",
  loanDecimals: 6,
  collateralDecimals: 18,
  version: 3,
  runtimeHash: `0x${"0".repeat(64)}`,
  startBlock: "1",
};
const context: OfferValidationContext = {
  market,
  account: address("d"),
  balance: maxUint256,
  now: Date.parse("2026-09-07T12:00:00Z") / 1000,
  marketAddresses: [market.address, address("e")],
};
const draft: OfferDraftInput = {
  visibility: "public",
  borrower: "",
  principal: "1000.000001",
  collateral: "10.000000000000000001",
  interest: "20.000001",
  duration: "30",
  expiry: "2026-09-08T12:00:00Z",
};

describe("validateOfferDraft", () => {
  test("retains exact amounts and expiry and ignores a borrower address for public offers", () => {
    expect(validateOfferDraft({ ...draft, borrower: "not a wallet" }, context)).toEqual({
      terms: {
        borrower: ZERO_ADDRESS,
        principal: 1_000_000_001n,
        collateral: 10_000_000_000_000_000_001n,
        interest: 20_000_001n,
        durationDays: 30,
        expiresAt: Date.parse(draft.expiry) / 1000,
      },
      errors: {},
    });
  });

  test("reports all missing fields together, including an explicit zero-interest instruction", () => {
    const result = validateOfferDraft({
      visibility: "private",
      borrower: " ",
      principal: "",
      collateral: " ",
      interest: "",
      duration: "",
      expiry: "",
    }, context);
    expect(result).toEqual({
      terms: null,
      errors: {
        borrower: "Enter the borrower wallet address.",
        principal: "Enter the loan amount.",
        collateral: "Enter the collateral amount.",
        interest: "Enter the interest amount, or 0 for no interest.",
        duration: "Enter the loan duration in days.",
        expiry: "Choose an offer expiry date and time.",
      },
    });
  });

  test.each(["-1", "+1", "1e3", "1,000", ".5", "1.", "NaN", "Infinity"])(
    "rejects malformed amount %s without coercion or exceptions",
    (value) => {
      const result = validateOfferDraft({ ...draft, principal: value, collateral: value, interest: value }, context);
      expect(result.terms).toBeNull();
      expect(result.errors).toEqual({
        principal: expect.stringMatching(/^Loan amount:.*digits and a decimal point/),
        collateral: expect.stringMatching(/^Collateral:.*digits and a decimal point/),
        interest: expect.stringMatching(/^Interest:.*digits and a decimal point/),
      });
    },
  );

  test("distinguishes zero principal and collateral from valid zero interest", () => {
    expect(validateOfferDraft({ ...draft, principal: "0", collateral: "0", interest: "0" }, context)).toEqual({
      terms: null,
      errors: {
        principal: "Loan amount must be greater than zero.",
        collateral: "Collateral must be greater than zero.",
      },
    });
    expect(validateOfferDraft({ ...draft, interest: "0" }, context).terms?.interest).toBe(0n);
  });

  test("enforces each token's decimal precision without rounding", () => {
    const result = validateOfferDraft({
      ...draft,
      principal: "1.0000001",
      collateral: "1.0000000000000000001",
      interest: "0.0000001",
    }, context);
    expect(result).toEqual({
      terms: null,
      errors: {
        principal: expect.stringMatching(/no more than 6 decimal places/),
        collateral: expect.stringMatching(/no more than 18 decimal places/),
        interest: expect.stringMatching(/no more than 6 decimal places/),
      },
    });
    const exact = validateOfferDraft({ ...draft, principal: " 9007199254740993.000001 ", interest: "0" }, context);
    expect(exact.terms?.principal).toBe(9_007_199_254_740_993_000_001n);
  });

  test("accepts the uint256 total boundary and rejects amount or total overflow", () => {
    const principal = formatAmount(maxUint256, 6);
    expect(validateOfferDraft({ ...draft, principal, interest: "0" }, context).terms?.principal).toBe(maxUint256);
    expect(validateOfferDraft({ ...draft, principal, interest: "0.000001" }, context)).toEqual({
      terms: null,
      errors: { interest: "Total repayment is too large. Reduce the principal or interest." },
    });
    const result = validateOfferDraft({
      ...draft,
      principal: formatAmount(maxUint256 + 1n, 6),
      collateral: formatAmount(maxUint256 + 1n, 18),
      interest: formatAmount(maxUint256 + 1n, 6),
    }, context);
    expect(result).toEqual({
      terms: null,
      errors: {
        principal: expect.stringMatching(/too large/),
        collateral: expect.stringMatching(/too large/),
        interest: expect.stringMatching(/too large/),
      },
    });
  });

  test("compares the available balance at the smallest USDG unit", () => {
    expect(validateOfferDraft(draft, { ...context, balance: 1_000_000_001n }).terms).not.toBeNull();
    expect(validateOfferDraft(draft, { ...context, balance: 1_000_000_000n })).toEqual({
      terms: null,
      errors: { principal: "Your wallet needs 1000.000001 USDG to fund this offer." },
    });
  });

  test("accepts an eligible private wallet and excludes zero, malformed, own and contract addresses", () => {
    expect(
      validateOfferDraft({ ...draft, visibility: "private", borrower: address("f") }, context)
        .terms?.borrower,
    ).toBe(address("f"));
    for (const borrower of [ZERO_ADDRESS, "0x123", context.account, market.address, address("E")]) {
      expect(validateOfferDraft({ ...draft, visibility: "private", borrower }, context)).toEqual({
        terms: null,
        errors: { borrower: "Enter a valid borrower wallet different from your wallet and the lending contracts." },
      });
    }
  });

  test.each(["0", "-1", "1.5", "1e2", " 30 ", "9007199254740992", "104249991375"])(
    "rejects unsafe or non-whole duration %s",
    (duration) => {
      expect(validateOfferDraft({ ...draft, duration }, context)).toEqual({
        terms: null,
        errors: { duration: "Enter the loan duration as a positive whole number of days." },
      });
    },
  );

  test("uses verified chain time for expiry and distinguishes malformed from past dates", () => {
    expect(validateOfferDraft({ ...draft, expiry: "not a date" }, context)).toEqual({
      terms: null,
      errors: { expiry: "Enter a valid offer expiry date and time." },
    });
    for (const seconds of [context.now - 1, context.now]) {
      expect(validateOfferDraft({ ...draft, expiry: new Date(seconds * 1000).toISOString() }, context)).toEqual({
        terms: null,
        errors: { expiry: "Choose an offer expiry in the future." },
      });
    }
    const future = new Date((context.now + 1) * 1000).toISOString();
    expect(validateOfferDraft({ ...draft, expiry: future }, context).terms?.expiresAt).toBe(context.now + 1);
  });

  test("retains the inclusive calendar bound for expiry, full duration and grace", () => {
    const expiry = new Date((8_640_000_000_000 - 2 * GRACE) * 1000).toISOString();
    expect(validateOfferDraft({ ...draft, expiry, duration: "1" }, context).terms).not.toBeNull();
    for (const input of [{ ...draft, expiry, duration: "2" }, { ...draft, duration: "100000000" }]) {
      expect(validateOfferDraft(input, context)).toEqual({
        terms: null,
        errors: {
          duration:
            "The selected terms exceed the supported calendar range. Choose an earlier expiry or shorter duration.",
        },
      });
    }
  });
});
