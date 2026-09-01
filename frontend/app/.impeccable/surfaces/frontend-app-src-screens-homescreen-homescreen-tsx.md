---
version: 1
slug: "frontend-app-src-screens-homescreen-homescreen-tsx"
primary_target: "src/screens/HomeScreen/HomeScreen.tsx"
related_targets: ["src/app/brand.css","src/comps/AppLayout/TopBar.tsx","src/comps/AppLayout/BottomBar.tsx","src/comps/Logo/Logo.tsx"]
---

# rUSD Home / Markets Surface

Mode: Operate

Topology reference: `.impeccable/mocks/rusd-v1-narrow-approved.png`. The user’s later direction supersedes its periwinkle palette, generic pictograms, and Geist display face.

Direction contract: A narrow, centered borrowing interface with the approachable simplicity of Liquity V1, expressed through an original rUSD identity. Use a pale mint field, white floating surfaces, deep turquoise actions, teal-black type, rounded corners, fine low-contrast rules, and quiet shadows. The page leads with one oversized Bricolage Grotesque promise, then a three-step collateral-to-rUSD mechanism, followed by the ten isolated stock markets. Keep the composition calm and compact; avoid exchange-terminal density, black corporate panels, glossy fintech gradients, and oversized full-bleed sections. The custom mechanism language is a stacked market card, a hexagonal collateral aperture, and a minted rUSD coin—not generic bank or safe pictograms. Risk copy is visible and friendly, not buried. Motion is limited to fast hover and focus feedback. The logo is an original looped rUSD mark, never a Liquity or Robinhood imitation.

## Component grammar

- Corners: 18px primary surfaces, 14px mobile shell, 10px controls, circular info mark.
- Lines: 1px low-contrast mint-gray separators.
- Elevation: one soft teal-gray ambient shadow on floating white surfaces; no hard or layered shadows.
- Type ramp: 50–72px Bricolage display headline, 17–20px lead, 11–15px interface copy.
- Spacing: centered 1040px maximum frame with 28px surface rhythm and generous hero breathing room.

## Element inventory

| Element | Required expression | Medium |
| --- | --- | --- |
| Brand | Original bright-turquoise looped rUSD mark with Bricolage wordmark | Semantic inline SVG |
| Navigation | Markets, Positions, Earn; testnet state; wallet action | Semantic HTML/CSS |
| Headline | “Borrow against Wall Street.” as the dominant two-line focal point | HTML/CSS |
| Mechanism | Stock card → collateral aperture → minted rUSD, connected by beaded arrows | Authored inline SVG + HTML/CSS |
| Markets | Ten isolated stock rows with ticker, max LTV, and action | Semantic HTML table + CSS |
| Primary actions | One per market, compact deep-turquoise Borrow control | Accessible links + CSS |
| Risk note | Soft mint explainer beneath the market list | HTML/CSS |
| Footer | Independent protocol disclaimer and utility links | HTML/CSS |
| Raster assets | None required; the world is deliberately vector and typographic | Accepted omission |

Compositional commitments: the header, hero, flow, market panel, risk note, and footer share one narrow centerline. The headline remains the largest element. The market list is a single continuous surface, not a card grid. On mobile, navigation collapses while the wallet action remains; the market table preserves ticker, LTV, and Borrow action.
