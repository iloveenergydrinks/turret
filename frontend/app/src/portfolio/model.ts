import type { Address } from "viem";
import type { Deployment, Loan } from "../p2p/client";
import type { NFTConfig, NFTOffer } from "../nft/client";

type PositionRead = { account: Address; now: number; blockNumber: bigint };
export type PoolPosition = PositionRead & {
  kind: "pool";
  shares: bigint;
  lendingAssets: bigint;
  maxWithdraw: bigint;
  collateral: bigint;
  debt: bigint;
};
export type P2PPosition = PositionRead & {
  kind: "p2p";
  offers: Loan[];
  credits: { USDG: bigint; COLLATERAL: bigint };
  nextCursor: bigint | null;
  nominalCredits?: { USDG: bigint; COLLATERAL: bigint };
  creditsComplete?: boolean;
  activeLoansComplete?: boolean;
  activeLoansMessage?: string;
};
export type NFTPosition = PositionRead & { kind: "nft"; offers: NFTOffer[]; nextCursor: bigint | null };
export type PortfolioPosition = PoolPosition | P2PPosition | NFTPosition;
type MarketBase = { id: string; symbol: string; name: string; legacy: boolean };
export type PoolMarket = MarketBase & {
  kind: "pool";
  engine: Address;
  collateralDecimals: number;
  read(account: Address): Promise<PoolPosition>;
};
export type P2PMarket = MarketBase & {
  kind: "p2p";
  deployment: Deployment;
  read(account: Address, cursor?: bigint): Promise<P2PPosition>;
};
export type NFTMarket = MarketBase & { kind: "nft"; deployment: NFTConfig; read(account: Address, cursor?: bigint): Promise<NFTPosition> };
export type PortfolioMarket = PoolMarket | P2PMarket | NFTMarket;
export type PortfolioSource = {
  id: "pools" | "p2p" | "nft";
  label: string;
  discover(): Promise<PortfolioMarket[]>;
};
export type MarketLoad = {
  sourceId: PortfolioSource["id"];
  market: PortfolioMarket;
  phase: "loading" | "ready" | "error";
  data?: PortfolioPosition;
  error?: string;
  refreshing: boolean;
  loadingOlder: boolean;
  olderError?: string;
};
export type SourceLoad = {
  id: PortfolioSource["id"];
  label: string;
  phase: "loading" | "ready" | "error";
  error?: string;
};
export type PortfolioState = { account: Address | null; sources: SourceLoad[]; markets: MarketLoad[] };
export const sameAccount = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
export const poolLink = (market: PoolMarket, section: "borrow" | "earn") => `/${section}?engine=${market.engine}`;
export const p2pLink = (market: P2PMarket, loanId?: bigint) =>
  `/borrow/p2p?market=${market.deployment.address}${loanId === undefined ? "" : `&offer=${loanId}`}`;

export function friendlyReadError(error: unknown) {
  if (error && typeof error === "object" && "shortMessage" in error && typeof error.shortMessage === "string") {
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : "The market could not be read. Try again.";
}

export function loadedP2PCredits(market: P2PMarket, data: P2PPosition) {
  if (market.deployment.version !== 3) return { available: data.credits, shortfall: { USDG: 0n, COLLATERAL: 0n }, unavailable: false };
  const result = { available: { USDG: 0n, COLLATERAL: 0n }, shortfall: { USDG: 0n, COLLATERAL: 0n }, unavailable: false };
  for (const loan of data.offers) for (const token of ["USDG", "COLLATERAL"] as const) {
    const credit = loan.loanCredits?.[token];
    if (credit?.unavailable && (sameAccount(loan.lender, data.account) || sameAccount(loan.borrower, data.account))) result.unavailable = true;
    if (credit && !credit.unavailable && sameAccount(credit.beneficiary, data.account)) {
      result.available[token] += credit.available;
      if (credit.nominal > credit.available) result.shortfall[token] += credit.nominal - credit.available;
    }
  }
  return result;
}
