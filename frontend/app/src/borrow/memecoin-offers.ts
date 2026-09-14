import type { Address } from "viem";
import type { Deployment, Loan, OfferPage } from "../p2p/client";

// Release-owned registry of exact deployed pairs. Candidate tokens are not admission.
import admissions from "../p2p/memecoin-admissions.json";
const admitted = admissions.schemaVersion === 1 && admissions.chainId === 4663 ? admissions.entries : [];
export const OFFER_FRESHNESS_MS = 30_000;
export type MemecoinMarketRead = {
  market: Deployment; page: OfferPage | null; checkedAt: number; error: boolean;
};
export type OfferAvailability = {
  state: "available" | "empty" | "paused" | "unavailable";
  offers: Loan[]; capacity: bigint; incomplete: boolean; unverified: number;
};

export function memecoinMarkets(markets: Deployment[]) {
  return markets.filter(m => m.chainId === 4663 && m.version === 3 && !m.legacy
    && m.loanToken.toLowerCase() === "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
    && m.loanDecimals === 6
    && admitted.some(a => a.manager === m.address.toLowerCase()
      && a.collateral === m.collateralToken.toLowerCase() && a.symbol === m.collateralSymbol && a.decimals === m.collateralDecimals));
}

/** Fresh observations inform discovery only. Acceptance rechecks the exact offer on chain. */
export function offerAvailability(read: MemecoinMarketRead, now: number, account?: Address): OfferAvailability {
  const unavailable: OfferAvailability = { state: "unavailable", offers: [], capacity: 0n, incomplete: true, unverified: 0 };
  const { page } = read;
  if (read.error || !page || now < read.checkedAt || now - read.checkedAt >= OFFER_FRESHNESS_MS
    || Math.abs(now - page.now * 1000) >= OFFER_FRESHNESS_MS) return unavailable;
  if (page.paused) return { ...unavailable, state: "paused", incomplete: false };
  if (page.health?.status !== "ok") return unavailable;
  let unverified = 0;
  const unique = new Map<string, Loan>();
  for (const loan of page.offers) {
    if (!loan.isPublic || loan.status !== "open" || loan.expiresAt * 1000 <= now
      || loan.principal <= 0n || loan.collateral <= 0n || loan.interest < 0n
      || !Number.isSafeInteger(loan.durationDays) || loan.durationDays <= 0
      || account?.toLowerCase() === loan.lender.toLowerCase()) continue;
    if (loan.fundingAvailable === undefined) { unverified++; continue; }
    if (loan.fundingAvailable < loan.principal) continue;
    unique.set(loan.id.toString(), loan);
  }
  const offers = [...unique.values()].sort((a,b) => a.principal < b.principal ? -1 : a.principal > b.principal ? 1
    : a.durationDays - b.durationDays || (a.interest < b.interest ? -1 : a.interest > b.interest ? 1 : 0));
  const incomplete = page.nextCursor !== null || unverified > 0;
  return {state: offers.length ? "available" : incomplete ? "unavailable" : "empty", offers,
    capacity: offers.reduce((sum,loan) => sum + loan.principal, 0n), incomplete, unverified};
}

export function exactOffers(offers: Loan[], amount: bigint | null, days: number | null) {
  return offers.filter(loan => (amount === null || loan.principal === amount) && (days === null || loan.durationDays === days));
}

export function offerHref(market: Deployment, loan: Loan) {
  return `/borrow/p2p?market=${market.address}&offer=${loan.id}`;
}

/** Bounded historical paging. Older offers are never asserted absent when scanning stops. */
export async function readOfferPages(client: {browse: (cursor?: bigint, atBlock?: bigint) => Promise<OfferPage>}, pages = 3): Promise<OfferPage> {
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 20) throw new Error("Invalid page limit");
  let page = await client.browse(), cursor = page.nextCursor;
  const offers = new Map(page.offers.map(loan => [loan.id.toString(), loan]));
  for (let index = 1; cursor !== null && index < pages; index++) {
    const older = await client.browse(cursor,page.blockNumber);
    if (older.blockNumber < page.blockNumber || (older.nextCursor !== null && older.nextCursor >= cursor)) {
      throw new Error("Offer history changed. Refresh availability.");
    }
    // Do not combine observations across blocks: a previously read offer may have been taken.
    if (older.blockNumber !== page.blockNumber || older.health?.blockHash !== page.health?.blockHash) throw new Error("Offer history changed. Refresh availability.");
    if (older.paused !== page.paused || older.health?.status !== "ok") throw new Error("Market checks changed");
    older.offers.forEach(loan => offers.set(loan.id.toString(),loan));
    page = {...older, offers:[...offers.values()]};
    cursor = older.nextCursor;
  }
  return page;
}
