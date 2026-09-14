import { type Address, createWalletClient, custom, type EIP1193Provider, type Hex } from "viem";
import type { Deployment } from "./client";
import { negotiationMessage } from "./negotiations-shared.mjs";
import type { RequestTerms } from "./requests";

export type NegotiationSource = {
  market: Address;
  chainId: number;
  id: string;
  lender: Address;
  borrower: Address;
  terms: RequestTerms;
  digest: string;
  status: number;
  backed?: boolean;
  now: number;
  blockNumber: string;
  blockHash: Hex;
};
export type Negotiation = {
  id: string;
  market: Address;
  chainId: number;
  offerId: string;
  sourceDigest: string;
  original: RequestTerms;
  lender: Address;
  borrower: Address;
  revision: number;
  state: "open" | "agreed" | "closed" | "replacing" | "recovering" | "funding" | "funded";
  createdAt: number;
  updatedAt: number;
  cancelHash?: Hex;
  attempt?: string;
  latest: { id: string; author: Address; terms: RequestTerms; responseBy: number; createdAt: number };
  replacement?: { id: string; hash: Hex; status: number; blockNumber: string };
};
export type NegotiationSession = { token: string; until: number; account: Address; origin: string };
type NegotiationContext = { sourceDigest: string; lender: Address; borrower: Address; proposalTerms: RequestTerms };
export type NegotiationAction = { action: "login" } | {
  action: "open";
  offerId: string;
  sourceDigest: string;
  terms: RequestTerms;
  responseBy: number;
} | {
  action: "counter";
  threadId: string;
  revision: number;
  proposalId: string;
  context: NegotiationContext;
  terms: RequestTerms;
  responseBy: number;
} | {
  action: "agree" | "close" | "start" | "prepare";
  threadId: string;
  revision: number;
  proposalId: string;
  context: NegotiationContext;
} | {
  action: "cancelled" | "bind";
  threadId: string;
  revision: number;
  proposalId: string;
  context: NegotiationContext;
  hash: Hex;
};
export type NegotiationEvent = {
  at: number;
  envelope: { action: string; account: Address; terms?: RequestTerms; responseBy?: number };
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
async function result(response: Response) {
  const value = await response.json().catch(() => {
    throw new Error("Negotiations unavailable. Refresh before retrying.");
  });
  if (!response.ok) throw new Error(value.error ?? "Negotiations unavailable.");
  if (value.origin !== window.location.origin) throw new Error("Negotiation origin mismatch.");
  return value;
}
export async function checkNegotiationWallet(provider: EIP1193Provider, account: Address, market: Deployment) {
  const [accounts, chain] = await Promise.all([
    provider.request({ method: "eth_accounts" }),
    provider.request({ method: "eth_chainId" }),
  ]);
  if (!accounts[0] || !same(accounts[0], account) || Number(BigInt(chain)) !== market.chainId) {
    throw new Error("Wallet or network changed. Reconnect before continuing.");
  }
}
export async function signNegotiation(
  provider: EIP1193Provider,
  account: Address,
  market: Deployment,
  action: NegotiationAction,
): Promise<{ thread: Negotiation } & NegotiationSession> {
  await checkNegotiationWallet(provider, account, market);
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = `0x${
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")
  }`;
  const envelope = {
    version: 1,
    origin: window.location.origin,
    account,
    chainId: market.chainId,
    market: market.address,
    nonce,
    issuedAt,
    validUntil: issuedAt + 300,
    ...action,
  };
  const signature = await createWalletClient({ transport: custom(provider) }).signMessage({
    account,
    message: negotiationMessage(envelope),
  });
  await checkNegotiationWallet(provider, account, market);
  // Retry the same signed envelope after an uncertain transport failure, never create a new action.
  const send = () =>
    fetch("/api/p2p/negotiations", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope, signature }),
    });
  let response;
  try {
    response = await send();
  } catch {
    response = await send();
  }
  return result(response);
}
export async function readNegotiations(
  session: NegotiationSession,
  query: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<
  {
    threads: Negotiation[];
    thread: Negotiation;
    source: NegotiationSource;
    events: NegotiationEvent[];
    nextCursor: string | null;
    now: number;
  }
> {
  if (session.until <= Date.now() / 1000 || session.origin !== window.location.origin) {
    throw new Error("Conversation session expired. Unlock again.");
  }
  return result(
    await fetch(`/api/p2p/negotiations?${new URLSearchParams(query)}`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Authorization: `Bearer ${session.token}` },
      signal,
    }),
  );
}
export const negotiationReference = (row: Negotiation) => ({
  threadId: row.id,
  revision: row.revision,
  proposalId: row.latest.id,
  context: {
    sourceDigest: row.sourceDigest,
    lender: row.lender,
    borrower: row.borrower,
    proposalTerms: row.latest.terms,
  },
});
