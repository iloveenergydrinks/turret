import { createWalletClient, custom, isAddress, type Address, type EIP1193Provider } from "viem";
import type { Deployment, Terms } from "./client";
import { requestActionMessage } from "./requests-shared.mjs";

export type RequestTerms = { principal: string; collateral: string; interest: string; durationDays: number; expiresAt: number };
export type RequestProposal = { id: string; lender: Address; terms: RequestTerms; createdAt: number; cancelled: boolean;
  fundedOffer: { id: string; status: "open" | "active" | "repaid" | "defaulted" | "cancelled" | "expired"; blockNumber: string; blockHash: string; checkedAt: number } | null };
export type BorrowerRequest = { id: string; sequence: number; revision: number; market: Address; chainId: number; borrower: Address;
  terms: RequestTerms; createdAt: number; status: "open" | "agreed" | "cancelled"; proposals: RequestProposal[]; acceptedProposalId: string | null };
export type RequestPage = { schemaVersion: 1; origin: string; now: number; requests: BorrowerRequest[]; nextCursor: string | null };
export type RequestFundingDraft = Terms & { requestId: string; proposalId: string; market: Deployment };
export type RequestAction = { action: "publish"; terms: RequestTerms }
  | { action: "propose"; requestId: string; revision: number; terms: RequestTerms }
  | { action: "accept" | "cancelProposal"; requestId: string; revision: number; proposalId: string }
  | { action: "cancel"; requestId: string; revision: number }
  | { action: "bind"; requestId: string; revision: number; proposalId: string; offerId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const address = (value: unknown): value is Address => typeof value === "string" && isAddress(value, { strict: false }) && !/^0x0{40}$/i.test(value);
const uint = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n;
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function validTerms(value: RequestTerms) {
  return value && uint(value.principal) && BigInt(value.principal) > 0n && uint(value.collateral) && BigInt(value.collateral) > 0n
    && uint(value.interest) && BigInt(value.principal) + BigInt(value.interest) < 1n << 256n
    && positiveInteger(value.durationDays) && positiveInteger(value.expiresAt)
    && BigInt(value.expiresAt) + BigInt(value.durationDays) * 86400n + 86400n <= 8_640_000_000_000n;
}
function validateRequest(row: BorrowerRequest): BorrowerRequest {
  if (!row || !UUID.test(row.id) || !positiveInteger(row.sequence) || !positiveInteger(row.revision)
    || !address(row.market) || !address(row.borrower) || same(row.market, row.borrower) || !positiveInteger(row.chainId)
    || !validTerms(row.terms) || !positiveInteger(row.createdAt) || !["open", "agreed", "cancelled"].includes(row.status)
    || !Array.isArray(row.proposals) || row.proposals.length > 20
    || (row.acceptedProposalId !== null && !UUID.test(row.acceptedProposalId))) throw new Error("The request board returned invalid listing data.");
  for (const p of row.proposals) {
    if (!p || !UUID.test(p.id) || !address(p.lender) || same(p.lender, row.borrower) || same(p.lender, row.market)
      || !validTerms(p.terms) || p.terms.expiresAt > row.terms.expiresAt || !positiveInteger(p.createdAt) || typeof p.cancelled !== "boolean"
      || (p.fundedOffer !== null && (!uint(p.fundedOffer?.id) || p.fundedOffer.id === "0" || !uint(p.fundedOffer.blockNumber)
        || !/^0x[0-9a-f]{64}$/i.test(p.fundedOffer.blockHash) || !positiveInteger(p.fundedOffer.checkedAt)
        || !["open", "active", "repaid", "defaulted", "cancelled", "expired"].includes(p.fundedOffer.status)))) throw new Error("The request board returned invalid proposal data.");
  }
  if (new Set(row.proposals.map(p => p.id)).size !== row.proposals.length
    || (row.acceptedProposalId && !row.proposals.some(p => p.id === row.acceptedProposalId))) throw new Error("The request board returned inconsistent proposals.");
  return row;
}
async function body(response: Response) {
  let result;
  try { result = await response.json(); } catch { throw new Error("The borrower request board is unavailable. Retry loading."); }
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "The borrower request board is unavailable. Retry loading.");
  return result;
}
export async function loadBorrowerRequests(filters: { market?: string; account?: string; cursor?: string; requestId?: string } = {}, signal?: AbortSignal): Promise<RequestPage> {
  const query = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => !!entry[1]));
  const result = await body(await fetch(`/api/p2p/requests?${query}`, { cache: "no-store", credentials: "same-origin", signal })) as RequestPage;
  if (result.schemaVersion !== 1 || result.origin !== window.location.origin || !positiveInteger(result.now)
    || !Array.isArray(result.requests) || result.requests.length > 30 || (result.nextCursor !== null && !/^[1-9][0-9]{0,14}$/.test(result.nextCursor))) throw new Error("The borrower request board returned an invalid response.");
  result.requests.forEach(validateRequest);
  const filteredAccount = filters.account;
  if (result.requests.some(row => (filters.market && !same(row.market, filters.market)) || (filters.requestId && row.id !== filters.requestId)
    || (filteredAccount && !same(row.borrower, filteredAccount) && !row.proposals.some(proposal => same(proposal.lender, filteredAccount))))) throw new Error("The request board returned listings outside the selected filters.");
  return result;
}
export async function signRequestAction(provider: EIP1193Provider, account: Address, market: Deployment, action: RequestAction): Promise<BorrowerRequest> {
  if (market.legacy || (market.version ?? 1) < 2) throw new Error("Requests require a current P2P market.");
  const check = async () => {
    const [accounts, chain] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
    if (!accounts[0] || !same(accounts[0], account) || Number(BigInt(chain)) !== market.chainId) throw new Error("Your wallet or network changed. Reconnect before signing this listing.");
  };
  await check();
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  const envelope = { version: 1, origin: window.location.origin, chainId: market.chainId, market: market.address,
    account, issuedAt, validUntil: issuedAt + 300, nonce, ...action };
  const signature = await createWalletClient({ transport: custom(provider) }).signMessage({ account, message: requestActionMessage(envelope) });
  await check();
  const result = await body(await fetch("/api/p2p/requests", { method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ envelope, signature }) })) as { schemaVersion: number; origin: string; request: BorrowerRequest };
  if (result.schemaVersion !== 1 || result.origin !== window.location.origin || !same(result.request?.market ?? "", market.address)
    || result.request.chainId !== market.chainId || (action.action !== "publish" && result.request.id !== action.requestId)
    || (action.action === "publish" && !same(result.request.borrower, account))) throw new Error("The board's confirmation could not be verified. Refresh before publishing again.");
  return validateRequest(result.request);
}
export function requestFundingDraft(request: BorrowerRequest, proposal: RequestProposal, market: Deployment): RequestFundingDraft {
  if (!same(request.market, market.address) || request.chainId !== market.chainId || !request.proposals.some(p => p.id === proposal.id)
    || proposal.cancelled || proposal.fundedOffer || request.status === "cancelled" || proposal.terms.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("This request or proposal is no longer available for funding.");
  return { requestId: request.id, proposalId: proposal.id, market, borrower: request.borrower,
    principal: BigInt(proposal.terms.principal), collateral: BigInt(proposal.terms.collateral), interest: BigInt(proposal.terms.interest),
    durationDays: proposal.terms.durationDays, expiresAt: proposal.terms.expiresAt };
}
/** Continue only with the exact new proposal returned by this publication. */
export function publishedProposalFunding(before: BorrowerRequest, saved: BorrowerRequest, market: Deployment, lender: Address, terms: RequestTerms): RequestFundingDraft {
  if (saved.id !== before.id || saved.revision <= before.revision || !same(saved.borrower, before.borrower)
    || !same(saved.market, before.market) || saved.chainId !== before.chainId) throw new Error("Your proposal was saved, but its funding details could not be verified. Refresh your proposals before funding.");
  const previousIds = new Set(before.proposals.map(proposal => proposal.id));
  const matches = saved.proposals.filter(proposal => !previousIds.has(proposal.id) && same(proposal.lender, lender)
    && proposal.terms.principal === terms.principal && proposal.terms.collateral === terms.collateral
    && proposal.terms.interest === terms.interest && proposal.terms.durationDays === terms.durationDays
    && proposal.terms.expiresAt === terms.expiresAt);
  if (matches.length !== 1) throw new Error("Your proposal was saved, but the matching terms could not be identified. Refresh your proposals before funding.");
  return requestFundingDraft(saved, matches[0]!, market);
}
/** Check again immediately before creating an offer; offchain cancellations cannot lock the chain. */
export async function validateRequestFunding(draft: RequestFundingDraft, account: Address, actualTerms: Terms = draft) {
  const page = await loadBorrowerRequests({ requestId: draft.requestId, market: draft.market.address });
  const request = page.requests[0];
  const proposal = request?.proposals.find(item => item.id === draft.proposalId);
  if (!request || !proposal || !same(proposal.lender, account) || request.chainId !== draft.market.chainId
    || request.status === "cancelled" || proposal.cancelled || proposal.fundedOffer
    || request.terms.expiresAt <= page.now || proposal.terms.expiresAt <= page.now) throw new Error("The request or your proposal changed, expired, was cancelled, or already has a funded offer. Refresh Requests before funding.");
  const terms = proposal.terms;
  if (!same(request.borrower, actualTerms.borrower) || actualTerms.principal !== BigInt(terms.principal)
    || actualTerms.collateral !== BigInt(terms.collateral) || actualTerms.interest !== BigInt(terms.interest)
    || actualTerms.durationDays !== terms.durationDays || actualTerms.expiresAt !== terms.expiresAt) throw new Error("These funding terms differ from your signed proposal. Return to Requests or create a separate offer.");
  return request;
}
/** Re-read the listing after funding so unrelated proposals cannot make linking silently stale. */
export async function bindRequestOffer(provider: EIP1193Provider, account: Address, draft: Pick<RequestFundingDraft, "requestId" | "proposalId" | "market">, offerId: bigint | string) {
  const page = await loadBorrowerRequests({ requestId: draft.requestId, market: draft.market.address });
  const request = page.requests[0];
  if (!request) throw new Error("The funded offer exists, but its borrower request could not be found. Keep the offer's direct link.");
  return signRequestAction(provider, account, draft.market, { action: "bind", requestId: request.id,
    revision: request.revision, proposalId: draft.proposalId, offerId: offerId.toString() });
}
