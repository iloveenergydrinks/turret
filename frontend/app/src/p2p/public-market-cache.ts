import type { Deployment, Loan, OfferPage } from "./client";

const PREFIX = "turret:p2p:public:v1:";
const TTL = 120_000;
const MAX_BYTES = 200_000;
const uint = (value: unknown): value is bigint => typeof value === "bigint" && value >= 0n && value < 1n << 256n;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const address = (value: unknown) => typeof value === "string" && /^0x[\da-f]{40}$/i.test(value);
const identity = (m: Deployment) => JSON.stringify([m.chainId, m.rpcUrl, m.address.toLowerCase(), m.runtimeHash,
  m.loanToken.toLowerCase(), m.collateralToken.toLowerCase(), m.loanDecimals, m.collateralDecimals, m.version, m.legacy]);
const key = (m: Deployment) => `${PREFIX}${m.chainId}:${m.address.toLowerCase()}`;
function validLoan(loan: Loan) {
  return loan && loan.isPublic === true && loan.status === "open" && address(loan.lender) && address(loan.borrower)
    && [loan.id, loan.principal, loan.collateral, loan.interest].every(uint)
    && [loan.createdAt, loan.durationDays, loan.expiresAt, loan.dueAt].every(integer);
}
/** Display-only public data, never wallet balances, permissions, private loans or transaction state. */
export function savePublicMarket(market: Deployment, page: OfferPage) {
  if (market.legacy || (market.version ?? 1) === 1) return;
  try {
    const publicPage = { offers: page.offers.filter(validLoan).slice(0, 100), now: page.now,
      blockNumber: page.blockNumber, paused: page.paused, nextCursor: page.nextCursor };
    const encoded = JSON.stringify({ identity: identity(market), at: Date.now(), page: publicPage },
      (_, value) => typeof value === "bigint" ? { $uint: value.toString() } : value);
    if (encoded.length <= MAX_BYTES) window.sessionStorage.setItem(key(market), encoded);
  } catch { /* Storage is optional; fresh reads remain authoritative. */ }
}
export function loadPublicMarket(market: Deployment): OfferPage | null {
  try {
    const raw = window.sessionStorage.getItem(key(market));
    if (!raw || raw.length > MAX_BYTES) return null;
    const value = JSON.parse(raw, (_, v) => v && typeof v === "object" && Object.keys(v).length === 1
      && typeof v.$uint === "string" && /^\d{1,78}$/.test(v.$uint) ? BigInt(v.$uint) : v);
    const elapsed = Date.now() - value.at, page = value.page as OfferPage;
    if (value.identity !== identity(market) || !integer(value.at) || elapsed < 0 || elapsed >= TTL
      || !page || !integer(page.now) || !uint(page.blockNumber) || typeof page.paused !== "boolean"
      || !(page.nextCursor === null || uint(page.nextCursor)) || !Array.isArray(page.offers)
      || page.offers.length > 100 || !page.offers.every(validLoan)) return null;
    const now = page.now + Math.floor(elapsed / 1000);
    return { ...page, now, offers: page.offers.filter(loan => loan.expiresAt > now) };
  } catch { return null; }
}
