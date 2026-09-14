/** One canonical, human-readable signing format shared by browser and server. */
export function requestActionMessage(envelope) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return "Turret P2P borrower request\nThis signature only publishes or updates an offchain listing. It does not transfer tokens, fund an offer, reserve funds, or open a loan.\nAmounts below are exact raw token units.\n\n"
    + JSON.stringify(canonical(envelope), null, 2);
}
