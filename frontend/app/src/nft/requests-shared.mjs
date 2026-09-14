/** Domain-separated, human-readable offchain NFT request signing format. */
export function nftRequestActionMessage(envelope) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  if (envelope.version === 2) {
    const cash = value => {
      const amount = BigInt(value), whole = amount / 1000000n, fraction = String(amount % 1000000n).padStart(6, "0").replace(/0+$/, "");
      return `${whole}${fraction ? `.${fraction}` : ""} USDG`;
    };
    const t = envelope.terms;
    const lines = [envelope.action === "publish" ? "Turret — Publish my NFT loan request" : "Turret — Remove my NFT loan listing",
      "", envelope.action === "publish" ? "Show these requested terms publicly. No loan starts and no assets move." : "Remove this listing only. Existing on-chain offers and loans remain unchanged.",
      `NFT collection: ${t.collection}`, `Token ID: #${t.tokenId}`, `Borrower: ${envelope.account}`,
      `Borrower receives: ${cash(t.principal)}`, `Full repayment: ${cash(BigInt(t.principal) + BigInt(t.interest))}`,
      `Interest included: ${cash(t.interest)} (full amount, even if repaid early)`,
      `Repay within: ${t.durationDays} days after on-chain acceptance, plus 24 hours of grace`,
      "After the final deadline, the lender can claim the entire NFT. No surplus refund.",
      `Listing closes: ${new Date(t.expiresAt * 1000).toISOString()}`, "",
      `Website: ${envelope.origin}`, `Chain ID: ${envelope.chainId}`, `Lending contract: ${envelope.market}`,
      `Action: ${envelope.action}`, ...(envelope.requestId ? [`Listing: ${envelope.requestId}`, `Revision: ${envelope.revision}`] : []),
      `Nonce: ${envelope.nonce}`, `Issued: ${new Date(envelope.issuedAt * 1000).toISOString()}`,
      `Signature valid until: ${new Date(envelope.validUntil * 1000).toISOString()}`, "Format: 2"];
    return lines.join("\n");
  }
  return "Turret NFT P2P borrower request\nThis signature only publishes or updates an offchain NFT listing. It does not approve or transfer your NFT, reserve USDG, or open a loan.\nThe collection address and token ID identify the exact NFT. USDG amounts are raw token units.\n\n"
    + JSON.stringify(canonical(envelope), null, 2);
}
