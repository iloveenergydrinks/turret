---
version: 1
slug: "frontend-app-src-screens-borrowscreen-borrowscreen-tsx"
primary_target: "src/screens/BorrowScreen/BorrowScreen.tsx"
related_targets: ["src/comps/Screen/Screen.tsx","src/comps/AppLayout/TopBar.tsx","src/app/brand.css"]
---

# Dockyard Borrow Workspace

Mode: Operate

The borrow workspace is one narrow, selected-market task. It names exactly one collateral, says that the transaction runs on Robinhood Chain, and groups collateral, rUSD debt, and interest configuration inside one white working surface. The page must never dump the full supported ticker set into its heading or use a generic “Testnet” label without the chain identity.

Keep the primary form visible and linear. Redemption education is available through a native disclosure below the rate field instead of competing with the transaction. On compact screens the selected market, Robinhood Chain Testnet identity, inputs, risk state, and final action remain visible and readable.
