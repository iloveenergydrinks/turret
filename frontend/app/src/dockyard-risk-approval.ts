import type { Address, Hex } from "viem";

export async function fetchRiskApproval(base: string, vault: Address, collateral: Address, adapter: Address, fetcher = fetch): Promise<Hex> {
  const url = new URL(`/approvals/${collateral}`, base);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Invalid risk monitor address.");
  const response = await fetcher(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Borrowing is temporarily unavailable. You can still repay or add collateral.");
  const body = await response.json();
  const now = Math.floor(Date.now() / 1000);
  if (body.chainId !== 4663 || body.vault?.toLowerCase() !== vault.toLowerCase()
    || body.collateral?.toLowerCase() !== collateral.toLowerCase() || body.adapter?.toLowerCase() !== adapter.toLowerCase()
    || !Number.isSafeInteger(body.validUntil) || body.validUntil < now + 10 || body.validUntil > now + 60
    || typeof body.encoded !== "string" || !/^0x(?:[a-fA-F0-9]{2}){64,1024}$/.test(body.encoded)) {
    throw new Error("The borrowing check expired or did not match this market. Please try again.");
  }
  // The contract verifies the signature, signer, round, epoch, lifetime and session.
  return body.encoded as Hex;
}
