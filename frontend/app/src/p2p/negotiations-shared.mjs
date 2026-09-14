/** Separate domain: never reuse a request, notification or transaction signature. */
export const canonicalNegotiation = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item);
export function negotiationMessage(envelope) {
  return "Turret P2P offer negotiation · v1\nOnly the named participants may read this conversation. This signature does not move tokens, reserve an onchain offer, or open a loan. Amounts are exact raw token units.\n\n"
    + canonicalNegotiation(envelope);
}
