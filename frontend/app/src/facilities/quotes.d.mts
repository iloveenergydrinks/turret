import type { Address, Hex } from "viem";

export type Quote = {
  epoch: string; nonce: string; borrower: Address; capacity: string; minDraw: string;
  collateralForCapacity: string; interestForCapacity: string; duration: string; validAfter: string; expiresAt: string;
};
export type SignedQuote = { schemaVersion: 1; chainId: number; facility: Address; quote: Quote; signature: Hex };
export type QuoteValues = { [K in keyof Quote]: K extends "borrower" ? Address : bigint };
export type FacilityLimits = {
  maxExposure: bigint; minDraw: bigint; maxDraw: bigint; minDuration: bigint; maxDuration: bigint;
  maxQuoteLifetime: bigint; minCollateralPerPrincipalWad: bigint; minInterestBps: bigint;
};
export type VerifiedBlock = { number: bigint; hash: Hex; timestamp: bigint };
export type FacilityObservation = {
  facility: Address; chainId: number; lender: Address; healthy: boolean; signatureValid: boolean; paused: boolean;
  epoch: bigint; idleCash: bigint; cashBalance: bigint; activePrincipal: bigint; unresolvedDefaultPrincipal: bigint;
  feeBps: bigint; limits: FacilityLimits; use: { digest: Hex; filled: bigint; cancelled: boolean };
  block: VerifiedBlock; checkedAt: number;
};
export type QuoteAvailability = {
  status: "unavailable" | "invalid" | "revoked" | "expired" | "scheduled" | "paused" | "filled" | "unfunded" | "available";
  reason: string | null; capacity: bigint; minDraw: bigint; maxDraw: bigint; borrowerEligible: boolean;
};
export type ObservedQuote = { envelope: SignedQuote; observation: FacilityObservation };
export type AvailableQuote = { id: Hex; envelope: SignedQuote; availability: QuoteAvailability };
export type QuoteOptions = { now?: number; account?: Address };
export const UINT_MAX: bigint;
export const MAX_TIME: bigint;
export const FRESH_MS: number;
export const ZERO_ADDRESS: Address;
export const ZERO_HASH: Hex;
export const quoteFields: (keyof Quote)[];
export const quoteTypes: { Quote: { name: string; type: "address" | "uint256" }[] };
export function same(a: unknown, b: unknown): boolean;
export function isAccount(value: unknown): value is Address;
export function exactKeys(value: unknown, keys: string[]): void;
export function uint(value: unknown): bigint;
export function quoteValues(value: unknown): QuoteValues;
export function parseSignedQuote(value: unknown): SignedQuote;
export function quoteTypedData(value: unknown): {
  domain: { name: "TurretLenderFacility"; version: "1"; chainId: number; verifyingContract: Address };
  types: typeof quoteTypes; primaryType: "Quote"; message: QuoteValues;
};
export function quoteDigest(value: unknown): Hex;
export function ceilDiv(a: bigint, b: bigint): bigint;
export function drawAmounts(value: SignedQuote, principal: bigint, feeBps: bigint): {
  principal: bigint; collateral: bigint; interest: bigint; repayment: bigint; fee: bigint; lenderRepayment: bigint;
};
export function validObservation(value: unknown, now: number): value is FacilityObservation;
export function assessQuote(value: unknown, observation: unknown, options?: QuoteOptions): QuoteAvailability;
/** capacity is an upper bound across shared cash and quote capacity, not a reserved or single-draw amount. */
export function summarizeFacilities(rows: ObservedQuote[], options?: QuoteOptions): {
  key: string; status: "unavailable" | "checked"; capacity: bigint; quotes: AvailableQuote[];
}[];
