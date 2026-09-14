import type { Address, Hex, createPublicClient } from "viem";
import type { TokenBaseline } from "../p2p/health-core.mjs";
import type { ObservedQuote, VerifiedBlock } from "./quotes.mjs";
export type FacilityEntry = {
  chainId: number; address: Address; lender: Address; loanToken: Address; collateralToken: Address;
  feeRecipient: Address; feeBps: string; vaultImplementation: Address; runtimeHash: Hex; vaultImplementationHash: Hex;
};
export type FacilityReadClient = Pick<ReturnType<typeof createPublicClient>, "getChainId" | "getBlock" | "getCode" | "getStorageAt" | "readContract" | "call">;
export const limitFields: string[];
export const facilityReadAbi: import("viem").Abi;
export function validateFacilityEntry(entry: unknown, baseline: unknown): TokenBaseline["tokens"];
export function readFacilityQuotes(client: FacilityReadClient, entry: FacilityEntry, baseline: TokenBaseline, quotes: unknown[], options?: {
  clock?: () => number; block?: VerifiedBlock;
}): Promise<{ block: VerifiedBlock; checkedAt: number; rows: (ObservedQuote & { id: Hex })[] }>;
