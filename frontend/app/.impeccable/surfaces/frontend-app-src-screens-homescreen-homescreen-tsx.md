---
version: 1
slug: "frontend-app-src-screens-homescreen-homescreen-tsx"
primary_target: "src/screens/HomeScreen/HomeScreen.tsx"
related_targets: ["src/app/brand.css","src/comps/AppLayout/TopBar.tsx","src/comps/AppLayout/BottomBar.tsx","src/comps/Logo/Logo.tsx"]
---

# rUSD Home / Markets Surface

Mode: Operate

Approved comp: `.impeccable/mocks/rusd-v1-narrow-approved.png`

Direction contract: A narrow, centered borrowing interface with the approachable simplicity of Liquity V1, expressed through an original rUSD identity. Use a pale lavender field, white floating surfaces, soft periwinkle actions, deep navy type, rounded corners, fine low-contrast rules, and quiet shadows. The page leads with one oversized plain-language promise, then a three-step collateral-to-rUSD mechanism, followed by the ten isolated stock markets. Keep the composition calm and compact; avoid exchange-terminal density, black corporate panels, glossy fintech gradients, and oversized full-bleed sections. Type is modern, rounded, and direct, with a high-contrast display headline and practical UI labels. Risk copy is visible and friendly, not buried. Motion is limited to fast hover and focus feedback. The logo is an original looped rUSD mark, never a Liquity or Robinhood imitation.

## Component grammar

- Corners: 18px primary surfaces, 14px mobile shell, 10px controls, circular info mark.
- Lines: 1px low-contrast lavender-gray separators.
- Elevation: one soft violet-gray ambient shadow on floating white surfaces; no hard or layered shadows.
- Type ramp: 48–76px display headline, 22px section heading, 17–20px lead, 12–14px interface copy.
- Spacing: centered 1040px maximum frame with 28px surface rhythm and generous hero breathing room.

## Element inventory

| Element | Required expression | Medium |
| --- | --- | --- |
| Brand | Original looped rUSD mark and wordmark | Semantic inline SVG |
| Navigation | Markets, Positions, Earn; testnet state; wallet action | Semantic HTML/CSS |
| Headline | “Borrow against Wall Street.” as the dominant two-line focal point | HTML/CSS |
| Mechanism | Stock Token → Vault → rUSD, three icons with arrows | Inline SVG + HTML/CSS |
| Markets | Ten isolated stock rows with ticker, max LTV, and action | Semantic HTML table + CSS |
| Primary actions | One per market, compact periwinkle Borrow control | Accessible links + CSS |
| Risk note | Soft lavender explainer beneath the market list | HTML/CSS |
| Footer | Independent protocol disclaimer and utility links | HTML/CSS |
| Raster assets | None required; the world is deliberately vector and typographic | Accepted omission |

Compositional commitments: the header, hero, flow, market panel, risk note, and footer share one narrow centerline. The headline remains the largest element. The market list is a single continuous surface, not a card grid. On mobile, navigation collapses while the wallet action remains; the market table preserves ticker, LTV, and Borrow action.
