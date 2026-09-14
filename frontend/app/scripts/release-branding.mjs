// Exact display-copy replacements only. Keep API hosts, ABI names and signature domains unchanged.
export const legacyBrandReplacements = [
  [
    "https://blog.dockyard.finance",
    "https://blog.turret.capital"
  ],
  [
    "Dockyard submits the loan with fresh price checks.",
    "Turret submits the loan with fresh price checks."
  ],
  [
    "Dockyard submits the transaction with fresh price checks and pays its network fee.",
    "Turret submits the transaction with fresh price checks and pays its network fee."
  ],
  [
    "Dockyard needs to restore the service.",
    "Turret needs to restore the service."
  ],
  [
    "This market is not configured for transactions on Dockyard.",
    "This market is not configured for transactions on Turret."
  ],
  [
    "Back to Dockyard",
    "Back to Turret"
  ],
  [
    "No Dockyard loan or collateral activity for this wallet yet.",
    "No Turret loan or collateral activity for this wallet yet."
  ],
  [
    "\"appName\":\"Dockyard\"",
    "\"appName\":\"Turret\""
  ],
  [
    "appName:\"Dockyard\"",
    "appName:\"Turret\""
  ],
  [
    "\"Dockyard home\"",
    "\"Turret home\""
  ],
  [
    "How borrowing with Dockyard works",
    "How borrowing with Turret works"
  ],
  [
    "Your Dockyard positions",
    "Your Turret positions"
  ],
  [
    "Explore Dockyard",
    "Explore Turret"
  ],
  [
    "receive Dockyard risk and liquidation notifications",
    "receive Turret risk and liquidation notifications"
  ],
  [
    "Check the link with Dockyard support.",
    "Check the link with Turret support."
  ],
  [
    "This address does not point to a Dockyard page.",
    "This address does not point to a Turret page."
  ],
  [
    "Dockyard-operated oracle",
    "Turret-operated oracle"
  ],
  [
    "Dockyard \u00b7 Independent Stock Token credit",
    "Turret \u00b7 Independent Stock Token credit"
  ],
  [
    "TURRET: lender rewards, USDG staking rewards and buybacks | Dockyard",
    "TURRET: lender rewards, USDG staking rewards and buybacks | Turret"
  ],
  [
    "What can I do with Dockyard?",
    "What can I do with Turret?"
  ],
  [
    "Dockyard lends existing USDG supplied to the vault by its owner.",
    "Turret lends existing USDG supplied to the vault by its owner."
  ],
  [
    "when Dockyard pauses borrowing",
    "when Turret pauses borrowing"
  ],
  [
    "How does Dockyard decide the Stock Token price?",
    "How does Turret decide the Stock Token price?"
  ],
  [
    "From Dockyard",
    "From Turret"
  ],
  [
    "Dockyard allows you to borrow USDG against your tokens",
    "Turret allows you to borrow USDG against your tokens"
  ]
];

export function rewriteLegacyBranding(text) {
  for (const [from, to] of legacyBrandReplacements) text = text.replaceAll(from, to);
  return text;
}

export function hasLegacyBranding(text) {
  return legacyBrandReplacements.some(([from]) => text.includes(from));
}
