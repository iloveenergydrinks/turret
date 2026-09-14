import type { Address } from "viem";
import type { Deployment, Terms } from "../../p2p/client";
import { GRACE, loanAmount, parseAmount, sameAddress, validAddress, ZERO_ADDRESS } from "./loanPresentation";

export type OfferField = "borrower" | "principal" | "collateral" | "interest" | "duration" | "expiry";
export type OfferErrors = Partial<Record<OfferField, string>>;
export type OfferDraftInput = Record<OfferField | "visibility", string>;
export type OfferValidationContext = {
  market: Deployment;
  account: Address;
  balance: bigint;
  now: number;
  marketAddresses: readonly string[];
};
export type OfferValidationResult =
  | { terms: Terms; errors: {} }
  | { terms: null; errors: OfferErrors };

/** Validate every editable term while preserving the contract's exact integer amounts. */
export function validateOfferDraft(input: OfferDraftInput, context: OfferValidationContext): OfferValidationResult {
  const errors: OfferErrors = {};
  const { market, account, balance, now, marketAddresses } = context;

  if (input.visibility === "private") {
    if (!input.borrower.trim()) {
      errors.borrower = "Enter the borrower wallet address.";
    } else if (
      !validAddress(input.borrower) || sameAddress(input.borrower, account)
      || marketAddresses.some((address) => sameAddress(address, input.borrower))
    ) {
      errors.borrower = "Enter a valid borrower wallet different from your wallet and the lending contracts.";
    }
  }

  const labels = { principal: "Loan amount", collateral: "Collateral", interest: "Interest" };
  function amount(field: keyof typeof labels, decimals: number): bigint | null {
    if (!input[field].trim()) {
      errors[field] = field === "interest"
        ? "Enter the interest amount, or 0 for no interest."
        : field === "principal"
        ? "Enter the loan amount."
        : "Enter the collateral amount.";
      return null;
    }
    try {
      const value = parseAmount(input[field], decimals);
      if (field !== "interest" && value <= 0n) {
        errors[field] = `${labels[field]} must be greater than zero.`;
      }
      return value;
    } catch (cause) {
      errors[field] = `${labels[field]}: ${cause instanceof Error ? cause.message : "Enter a valid amount."}`;
      return null;
    }
  }
  const principal = amount("principal", market.loanDecimals);
  const collateral = amount("collateral", market.collateralDecimals);
  const interest = amount("interest", market.loanDecimals);
  if (principal !== null && interest !== null && principal + interest >= 2n ** 256n) {
    errors.interest = "Total repayment is too large. Reduce the principal or interest.";
  }
  if (principal !== null && principal > balance) {
    errors.principal = `Your wallet needs ${loanAmount(principal, market)} to fund this offer.`;
  }

  const durationDays = Number(input.duration);
  if (!input.duration.trim()) {
    errors.duration = "Enter the loan duration in days.";
  } else if (
    !/^\d+$/.test(input.duration) || !Number.isSafeInteger(durationDays) || durationDays <= 0
    || !Number.isSafeInteger(durationDays * GRACE)
  ) {
    errors.duration = "Enter the loan duration as a positive whole number of days.";
  }

  const expiresAt = Math.floor(new Date(input.expiry).getTime() / 1000);
  if (!input.expiry.trim()) {
    errors.expiry = "Choose an offer expiry date and time.";
  } else if (!Number.isSafeInteger(expiresAt)) {
    errors.expiry = "Enter a valid offer expiry date and time.";
  } else if (expiresAt <= now) {
    errors.expiry = "Choose an offer expiry in the future.";
  }
  if (
    !errors.duration && !errors.expiry
    && BigInt(expiresAt) + BigInt(durationDays) * 86_400n + 86_400n > 8_640_000_000_000n
  ) {
    errors.duration =
      "The selected terms exceed the supported calendar range. Choose an earlier expiry or shorter duration.";
  }

  if (Object.keys(errors).length || principal === null || collateral === null || interest === null) {
    return { terms: null, errors };
  }
  return {
    terms: {
      borrower: input.visibility === "public" ? ZERO_ADDRESS : input.borrower as Address,
      principal,
      collateral,
      interest,
      durationDays,
      expiresAt,
    },
    errors: {},
  };
}
