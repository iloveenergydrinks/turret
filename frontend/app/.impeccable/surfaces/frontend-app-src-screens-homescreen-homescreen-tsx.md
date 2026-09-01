---
version: 1
slug: "frontend-app-src-screens-homescreen-homescreen-tsx"
primary_target: "src/screens/HomeScreen/HomeScreen.tsx"
related_targets: ["src/app/brand.css","src/comps/AppLayout/TopBar.tsx","src/comps/AppLayout/BottomBar.tsx","src/comps/Logo/Logo.tsx"]
---

# Dockyard Home / Markets Surface

Mode: Operate

Approved composition: `.impeccable/mocks/dockyard-home-option-b.png`. Preserve its centered narrow borrowing desk, compact horizontal mechanism, and continuous market table. The user explicitly rejected the generated contour-line background; implementation replaces it with a slow animated mesh gradient informed by Paper Shaders.

Direction contract: A narrow, centered borrowing interface with the approachable simplicity of Liquity V1, expressed through the Dockyard protocol identity while rUSD remains the currency. Use a pale sea-glass mesh gradient field, white floating surfaces, deep turquoise actions, teal-black type, rounded corners, fine low-contrast rules, and quiet shadows. The page leads with one oversized Qubic Grid promise, then a horizontal three-step collateral-to-rUSD mechanism, followed by the ten isolated stock markets. Keep the composition calm and compact; avoid exchange-terminal density, dark corporate panels, hard chart contours, glossy fintech gradients, and literal nautical decoration. Risk copy is visible and friendly, not buried. The only prominent continuous motion is the slow mesh-gradient shader, with reduced-motion stopping the animation. The logo is the selected four-part safe-harbor mark: rounded dock modules protecting a central berth, never a Liquity, Robinhood, anchor, or ship imitation.

## Component grammar

- Corners: 18px primary surfaces, 14px mobile shell, 10px controls, circular info mark.
- Lines: 1px low-contrast mint-gray separators.
- Elevation: one soft teal-gray ambient shadow on floating white surfaces; no hard or layered shadows.
- Type ramp: 50–72px Qubic Grid display headline, 17–20px lead, 11–15px Geist interface copy.
- Spacing: centered 1040px maximum frame with 28px surface rhythm and generous hero breathing room.

## Element inventory

| Element | Required expression | Medium |
| --- | --- | --- |
| Brand | Selected four-part safe-harbor mark with lowercase Qubic Grid wordmark | Transparent raster mark + semantic HTML |
| Navigation | Markets, Positions, Earn; testnet state; wallet action | Semantic HTML/CSS |
| Headline | “Borrow against Wall Street.” as the dominant two-line focal point | HTML/CSS |
| Mechanism | Stock card → collateral aperture → minted rUSD, connected by beaded arrows | Authored inline SVG + HTML/CSS |
| Markets | Ten isolated stock rows with ticker, max LTV, and action | Semantic HTML table + CSS |
| Primary actions | One per market, compact sea-glass Borrow control that inverts to deep turquoise on hover | Accessible links + CSS |
| Risk note | Soft mint explainer beneath the market list | HTML/CSS |
| Footer | Independent protocol disclaimer and utility links | HTML/CSS |
| Background | Full-viewport sea-glass mesh gradient; slow organic distortion, low contrast, no pointer reaction; static under reduced motion | Paper Shaders WebGL canvas |
| Raster assets | Selected safe-harbor mark, with a 512px web asset and preserved high-resolution original | Transparent PNG |

Compositional commitments: the header, hero, flow, market panel, risk note, and footer share one narrow centerline. The headline remains the largest element. The market list is a single continuous surface, not a card grid. The animated gradient fills the viewport behind the shell and never competes with text or controls. On mobile, navigation collapses while the wallet action remains; the market table preserves ticker, LTV, and Borrow action. Reduced-motion users receive the same gradient frozen at a deliberate frame.
