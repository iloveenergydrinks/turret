import { isAddress, toHex, type Address, type EIP1193Provider } from "viem";
import { nftRequestActionMessage } from "./requests-shared.mjs";
import { NFTClient, same, type NFTTerms } from "./client";

export type ListingTerms = { collection: Address; tokenId: string; principal: string; interest: string; durationDays: number; expiresAt: number };
export type NFTProposal = { id: string; lender: Address; terms: ListingTerms; cancelled: boolean;
  fundedOffer: null | { id: string; status: string; checkedAt: number } };
export type NFTRequest = { id: string; revision: number; borrower: Address; terms: ListingTerms;
  liveOffers?: { id: string; lender: Address; status: string; checkedAt: number; terms: ListingTerms }[];
  status: "open" | "agreed" | "cancelled"; proposals: NFTProposal[]; acceptedProposalId: string | null };
export type RequestPage = { origin: string; now: number; requests: NFTRequest[]; nextCursor: string | null };
const uint = (s: unknown): s is string => typeof s === "string" && /^(0|[1-9][0-9]{0,77})$/.test(s) && BigInt(s) < 2n ** 256n;
const uuid = (s: unknown) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const address = (a: unknown): a is Address => typeof a === "string" && isAddress(a, { strict: false }) && !/^0x0{40}$/i.test(a);
function validStoredTerms(t: ListingTerms) {
  return !!t && address(t.collection) && uint(t.tokenId) && uint(t.principal) && BigInt(t.principal) > 0n && uint(t.interest)
    && BigInt(t.principal) + BigInt(t.interest) < 2n ** 256n
    && Number.isSafeInteger(t.durationDays) && t.durationDays > 0 && Number.isSafeInteger(t.expiresAt) && t.expiresAt > 0
    && BigInt(t.expiresAt) + BigInt(t.durationDays) * 86400n + 86400n <= 8_640_000_000_000n;
}
export function validateNFTRequest(row: NFTRequest): NFTRequest {
  if (!row || !uuid(row.id) || !address(row.borrower) || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !["open", "agreed", "cancelled"].includes(row.status) || !validStoredTerms(row.terms)
    || !Array.isArray(row.proposals) || row.proposals.length > 20
    || row.proposals.some(p => !p || !uuid(p.id) || !address(p.lender) || typeof p.cancelled !== "boolean" || !validStoredTerms(p.terms)
      || !same(p.terms.collection, row.terms.collection) || p.terms.tokenId !== row.terms.tokenId
      || (p.fundedOffer !== null && (!p.fundedOffer || !uint(p.fundedOffer.id) || p.fundedOffer.id === "0"
        || !["open", "active", "repaid", "defaulted", "cancelled", "expired"].includes(p.fundedOffer.status)
        || !Number.isSafeInteger(p.fundedOffer.checkedAt))))
    || (row.liveOffers !== undefined && (!Array.isArray(row.liveOffers) || row.liveOffers.length > 100
      || row.liveOffers.some(o => !uint(o.id) || o.id === "0" || !address(o.lender) || !validStoredTerms(o.terms)
        || !same(o.terms.collection, row.terms.collection) || o.terms.tokenId !== row.terms.tokenId
        || !["open", "active", "repaid", "defaulted", "cancelled", "expired"].includes(o.status) || !Number.isSafeInteger(o.checkedAt))))
    || new Set(row.proposals.map(p => p.id)).size !== row.proposals.length
    || (row.acceptedProposalId !== null && !row.proposals.some(p => p.id === row.acceptedProposalId))) {
    throw Error("NFT request board returned invalid loan terms. Refresh before acting.");
  }
  return row;
}

export function validateListingTerms(t: ListingTerms, client: NFTClient, now: number): NFTTerms {
  if (!t || !client.config.collections.some(c => c.enabled && same(c.address, t.collection))
    || !uint(t.tokenId) || !uint(t.principal) || !uint(t.interest) || BigInt(t.principal) === 0n
    || BigInt(t.principal) + BigInt(t.interest) >= 2n ** 256n
    || !Number.isSafeInteger(t.durationDays) || t.durationDays < 1
    || !Number.isSafeInteger(t.expiresAt) || t.expiresAt <= now || t.expiresAt > now + 30 * 86400
    || BigInt(t.expiresAt) + BigInt(t.durationDays) * 86400n + 86400n > 8_640_000_000_000n) {
    throw Error("Choose a supported NFT, positive USDG amount, nonnegative interest, whole days and a future expiry within 30 days.");
  }
  return { borrower: "0x0000000000000000000000000000000000000000", collection: t.collection, tokenId: BigInt(t.tokenId),
    principal: BigInt(t.principal), interest: BigInt(t.interest), duration: BigInt(t.durationDays) * 86400n, expiresAt: BigInt(t.expiresAt) };
}

async function responseJSON(response: Response) {
  const result = await response.json();
  if (!response.ok) throw Error(typeof result?.error === "string" ? result.error : "NFT request board is unavailable.");
  if (result?.schemaVersion !== 1 || result.origin !== window.location.origin || !Number.isSafeInteger(result.now)) {
    throw Error("NFT request board returned an invalid response.");
  }
  return result;
}
export async function listNFTRequests(filters: Record<string, string> = {}): Promise<RequestPage> {
  const result = await responseJSON(await fetch(`/api/p2p/nft/requests?${new URLSearchParams(filters)}`, { cache: "no-store" }));
  if (!Array.isArray(result.requests) || result.requests.length > 30
    || (result.nextCursor !== null && !uint(result.nextCursor))) throw Error("NFT request page is invalid.");
  result.requests.forEach(validateNFTRequest);
  return result;
}
export async function submitNFTRequest(client: NFTClient, provider: EIP1193Provider, account: Address,
  action: Record<string, unknown>): Promise<NFTRequest> {
  await client.walletCheck(provider, account);
  const page = await listNFTRequests({ market: client.config.address });
  const nonce = new Uint8Array(32); crypto.getRandomValues(nonce);
  const envelope = { ...action, version: 2, origin: window.location.origin, chainId: client.config.chainId,
    market: client.config.address, account, issuedAt: page.now, validUntil: page.now + 300, nonce: toHex(nonce) };
  const signature = await provider.request({ method: "personal_sign", params: [toHex(nftRequestActionMessage(envelope)), account] });
  await client.walletCheck(provider, account);
  const result = await responseJSON(await fetch("/api/p2p/nft/requests", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envelope, signature }) }));
  if (!result.request?.id) throw Error("NFT listing could not be confirmed. Refresh before retrying.");
  return validateNFTRequest(result.request);
}
