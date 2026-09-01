---
name: "Dockyard"
description: "A sea-glass borrowing desk for turning tokenized equity collateral into rUSD liquidity."
colors:
  turquoise-action: "#08786E"
  turquoise-action-hover: "#05675F"
  turquoise-bright: "#0FAE9B"
  favicon-wave: "#8EF0DC"
  mint-field: "#F0FAF8"
  paper-surface: "#FFFFFF"
  teal-ink: "#102B2A"
  quiet-slate: "#5A7270"
  mint-line: "#D8EAE6"
  mint-soft: "#DDF5F0"
  table-frost: "#F7FCFB"
  risk-copy: "#18554F"
  testnet-amber: "#D97645"
  preview-cream: "#FFF7E9"
  preview-line: "#EDD7AA"
  mesh-mist: "#F5FBFA"
  mesh-mint: "#C4EFE6"
  mesh-sea-glass: "#A4DFD3"
  mesh-sky: "#C9DEF3"
  mesh-sand: "#F5E8C3"
typography:
  display:
    fontFamily: "Qubic Grid Variable, Avenir Next, Arial, sans-serif"
    fontSize: "clamp(50px, 4.75vw, 72px)"
    fontWeight: 650
    lineHeight: 0.98
    letterSpacing: "-0.03em"
  mobile-display:
    fontFamily: "Qubic Grid Variable, Avenir Next, Arial, sans-serif"
    fontSize: "clamp(44px, 13vw, 60px)"
    fontWeight: 650
    lineHeight: 0.98
    letterSpacing: "-0.03em"
  lead:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "clamp(17px, 2vw, 20px)"
    fontWeight: 400
    lineHeight: 1.55
  market-title:
    fontFamily: "Qubic Grid Variable, Avenir Next, Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1
  title:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.55
  body:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  navigation:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 660
  action:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 700
  label:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.08em"
  metadata:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  info-mark:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "21px"
    fontWeight: 750
rounded:
  nav-active: "3px 3px 0 0"
  ticker: "9px"
  control: "10px"
  notice: "12px"
  mobile-shell: "14px"
  mobile-icon: "15px"
  surface: "18px"
  flow-icon: "24px"
  pill: "999px"
  circle: "50%"
spacing:
  xs: "8px"
  sm: "12px"
  md: "18px"
  lg: "28px"
  xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.turquoise-action}"
    textColor: "{colors.paper-surface}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.turquoise-action-hover}"
    textColor: "{colors.paper-surface}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
  account-button:
    backgroundColor: "{colors.turquoise-action}"
    textColor: "{colors.paper-surface}"
    rounded: "{rounded.pill}"
    padding: "0 14px"
    height: "40px"
  market-panel:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.teal-ink}"
    rounded: "{rounded.surface}"
    width: "100%"
  ticker-chip:
    backgroundColor: "{colors.mint-soft}"
    textColor: "{colors.turquoise-action}"
    typography: "{typography.metadata}"
    rounded: "{rounded.ticker}"
    width: "52px"
    height: "32px"
  info-panel:
    backgroundColor: "{colors.mint-soft}"
    textColor: "{colors.risk-copy}"
    rounded: "{rounded.surface}"
    padding: "22px 26px"
  preview-badge:
    backgroundColor: "{colors.mint-soft}"
    textColor: "{colors.turquoise-action}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "32px"
---

# Design System: Dockyard

## Overview

**Creative North Star: "The Sea-Glass Dockyard Desk"**

Dockyard turns isolated Stock Token markets into one approachable borrowing desk. A slowly shifting sea-glass field establishes place, while a narrow centerline of white work surfaces, deep turquoise controls, and blue-green ink keeps the product practical. The atmosphere is maritime through light, tide-like motion, and the protected-channel negative space inside the D—not through anchors, ships, rope, or decorative nautical scenery.

The protocol is Dockyard; rUSD is the dollar-denominated stablecoin users borrow. Dockyard owns the navigation, logo, shell, and overall visual world. rUSD appears as the output currency in the borrowing mechanism, balances, debt, repayment, and redemption. Internal CSS custom properties and class names may retain the `rusd-` prefix for implementation stability; that prefix is not user-facing identity and must never be used to rename the protocol in copy or visual assets.

The system is narrow, friendly, and direct. It inherits Liquity V1's approachable simplicity without copying Liquity or Robinhood identity. It refuses exchange-terminal density, black corporate panels, glossy fintech spectacle, and the rejected contour-line background. The approved background is the Paper Shaders `MeshGradient`, kept low-contrast and subordinate to risk comprehension and borrowing actions.

**Shipped reference:** The implemented home surface follows approved Option B (`.impeccable/mocks/dockyard-home-option-b.png`) with the user's mesh-gradient revision. Finish-review disposition: **ship**; all material fixes are resolved.

**Key Characteristics:**

- A single centered 1040px frame with generous hero breathing room and compact information surfaces.
- One oversized, plain-language Qubic Grid promise followed by a concise collateral-to-rUSD mechanism.
- A living sea-glass mesh behind translucent paper surfaces, never contours or pointer-reactive effects.
- Fine mint separators, rounded practical controls, and one quiet ambient depth device per surface.
- An AI-generated Dockyard D built around a protected harbor and entering channel.
- Explicit risk, preview, and network language that never relies on color alone.

## Colors

The palette combines a deep turquoise action voice with misted mint surfaces and a restrained five-color sea-glass shader.

### Primary

- **Turquoise Action** (`#08786E`): The sole primary interaction color for buttons, active navigation, links, focus identity, the Dockyard dock lines, and mechanism icons.
- **Turquoise Action Hover** (`#05675F`): The darker pointer-hover response for primary actions.
- **Turquoise Bright** (`#0FAE9B`): The entering-channel accent inside the Dockyard mark and the mechanism connectors; use it as geometry, not small text on white.
- **Favicon Wave** (`#8EF0DC`): The lighter wave stroke used only where the mark sits on its dark Turquoise Action favicon tile.

### Secondary

- **Mint Soft** (`#DDF5F0`): Ticker chips, risk surfaces, preview badges, and supportive emphasis.
- **Sea-Glass Mint** (`#C4EFE6`) and **Sea-Glass Green** (`#A4DFD3`): The two green anchors of the full-viewport mesh.

### Tertiary

- **Mesh Sky** (`#C9DEF3`): A cool blue drift in the shader that keeps the field from becoming a flat mint wash.
- **Mesh Sand** (`#F5E8C3`): A sparse warm counterpoint in the shader, suggesting light on a working harbor without becoming beige branding.
- **Testnet Amber** (`#D97645`): A compact status dot paired with the explicit “Testnet” label.

### Neutral

- **Mint Field** (`#F0FAF8`): The fallback page ground beneath the shader.
- **Mesh Mist** (`#F5FBFA`): The lightest shader stop.
- **Paper Surface** (`#FFFFFF`): Navigation, market surfaces, the risk information mark, and text on primary actions.
- **Teal Ink** (`#102B2A`): Primary text, the Dockyard wordmark, active navigation, market symbols, and headline ink.
- **Quiet Slate** (`#5A7270`): Supporting copy, inactive navigation, network labels, market descriptions, and footer text.
- **Mint Line** (`#D8EAE6`): Fine table rules and quiet divisions.
- **Table Frost** (`#F7FCFB`): Table headings, mechanism tiles, and row-hover feedback.
- **Risk Copy** (`#18554F`): Consequential explanatory text inside the mint risk panel.
- **Preview Cream** (`#FFF7E9`) and **Preview Line** (`#EDD7AA`): Read-only product-preview notice fill and border.

### Named Rules

**The One Action Voice Rule.** Turquoise Action carries primary interaction hierarchy; Turquoise Bright is reserved for brand and flow geometry.

**The Living Field Rule.** The five shader colors move as a low-contrast environmental field. They do not become button fills, chart series, or competing foreground gradients.

**The Risk Is More Than Color Rule.** Status color must be paired with explicit text, a label, or another perceivable cue.

## Typography

**Display Font:** Qubic Grid Variable (with Avenir Next, Arial, and sans-serif fallbacks)

**Body Font:** Geist (with Arial and sans-serif fallbacks)

**Character:** Qubic Grid gives Dockyard a precise, engineered voice with enough warmth to stay approachable. Its squared details subtly echo market infrastructure and dock construction without becoming a sci-fi costume. Geist remains the reading, interface, and numeric workhorse so financial information stays stable and familiar.

### Hierarchy

- **Display** (650, `clamp(50px, 4.75vw, 72px)`, 0.98): The dominant Qubic Grid promise on wide screens, with `-0.03em` tracking. At 760px and below it becomes `clamp(44px, 13vw, 60px)`.
- **Lead** (400, `clamp(17px, 2vw, 20px)`, 1.55): Short literal explanation under the display statement, balanced and capped at 620px.
- **Market Title** (650, 18px, 1): Compact section signage in Qubic Grid; it becomes 17px on compact screens.
- **Title** (700, 15px, 1.55): Emphasis inside explanatory surfaces and market names.
- **Body** (400, 14px, 1.55 where prose needs it): Market data and practical interface copy in Geist.
- **Navigation** (660, 14px): Geist route labels with an open, stable rhythm.
- **Action** (700, 13px): Borrow actions, flow labels, and explanatory links.
- **Label** (700, 11px, `0.08em`): Uppercase table headings only.
- **Metadata** (400, 12px): Secondary market, network, and footer copy; ticker identifiers increase weight to 760.

### Named Rules

**The Plain Promise Rule.** Let one short, high-contrast display line carry the page; supporting copy stays smaller, calmer, and literal.

**The Protocol-and-Currency Rule.** Set “Dockyard” as the protocol wordmark and shell identity. Set “rUSD” as a currency label, never as the product name.

**The Practical Label Rule.** Uppercase and wide tracking belong to table metadata, not body copy or calls to action.

## Layout

The spatial model is one narrow centerline: a fluid frame capped at 1040px and inset 16px per side on wide screens. The main region uses 28px top and 48px bottom padding, and the home stack uses an 18px vertical rhythm. The hero is centered, while data and risk content remain left-aligned for scanning. The fixed, full-viewport shader sits behind the shell; content remains in a higher isolated layer.

The top bar uses a three-column grid so the Dockyard brand, centered route navigation, and account state balance without widening the content. The borrowing mechanism uses three steps—Stock Token, Vault, rUSD—connected by compact beaded wave arrows. The ten markets remain one continuous fixed-layout table rather than splitting into cards.

At the single implemented breakpoint (760px), the frame inset tightens from 16px to 10px. The top bar becomes a 56px, two-column shell with 14px corners; route navigation and the textual network state hide while the Dockyard logo and account action remain. The hero type and mechanism icons scale down. The market table preserves ticker, Max LTV, and Borrow/Not live action, hides secondary market descriptions, narrows numeric and action columns, and increases row height to 54px. The risk link moves under its copy, and the footer stacks vertically.

**The One Centerline Rule.** Brand, message, mechanism, market list, risk note, and footer align to the same capped frame.

**The Continuous Market Rule.** Keep comparable markets in one scan-friendly table; do not turn the list into a responsive card mosaic.

## Elevation & Depth

Depth is ambient and layered over the mesh. The top bar uses a translucent paper fill (`rgba(255, 255, 255, 0.92)`) with `0 8px 28px rgba(15, 68, 63, 0.08)`. The market surface uses a slightly denser paper fill (`rgba(255, 255, 255, 0.94)`) with `0 10px 34px rgba(15, 68, 63, 0.09)`. Mechanism tiles use Table Frost, a hairline turquoise border, and a quiet inset mint glow rather than exterior lift. A translucent frost veil (`rgba(247, 252, 251, 0.16)`) sits over the shader to protect contrast.

### Shadow Vocabulary

- **Ambient Navigation** (`0 8px 28px rgba(15, 68, 63, 0.08)`): Low lift for the sticky paper top bar.
- **Ambient Panel** (`0 10px 34px rgba(15, 68, 63, 0.09)`): Slightly broader lift for the continuous market surface.
- **Inset Tide** (`inset 0 -10px 24px rgba(15, 174, 155, 0.08)`): A restrained lower-edge tint inside mechanism icon tiles.

### Named Rules

**The One Depth Device Rule.** A surface may use one ambient shadow or tonal separation; never stack hard borders, multiple shadows, and glow on the same surface.

**The Shader Stays Behind Rule.** Mesh motion provides atmosphere, not elevation. Foreground hierarchy must remain legible if the shader is frozen or unavailable.

## Shapes

The form language combines rounded working surfaces with authored line geometry. Primary floating surfaces use 18px corners; mechanism tiles use 24px on wide screens and 15px on compact screens; controls use 10px; ticker chips use 9px; preview notices use 12px; and the compact top bar uses 14px. The account control and preview badges are full pills, while status dots and the information mark are circular. Borders are one pixel and low contrast; they divide information instead of boxing every element.

The Dockyard mark is an AI-generated D refined from a six-direction identity exploration. Its deep-teal outer form creates a protected circular harbor in negative space, while one turquoise channel enters from the lower-left. The Qubic Grid “Dockyard” wordmark sits to its right. The same transparent raster mark is used for the favicon and navigation; the high-resolution original is preserved under `public/brand/`. The borrowing flow has its own semantic icons—stacked market cards, a hexagonal collateral aperture, and a minted rUSD coin—but none of these replaces the protocol mark.

**The One Channel Rule.** The logo uses one restrained turquoise channel entering a protected negative-space harbor; do not add anchors, ships, rope, portholes, or extra waves.

**The Soft Structure Rule.** Use roundness to soften clear structure, not to turn every label or data cell into a pill.

## Components

### Buttons

Buttons feel compact, direct, and responsive.

- **Shape:** Borrow actions use 10px corners; the account action uses a full pill.
- **Primary:** Paper text on Turquoise Action. Borrow actions are at least 88px by 36px with 16px horizontal padding; the account action is 40px high with 14px horizontal padding.
- **Hover / Focus / Active:** Hover darkens to Turquoise Action Hover and lifts Borrow actions by 1px over 140ms ease-out. Active controls compress to 98%. Keyboard focus uses a 3px translucent turquoise outline with a 3px offset.
- **Disabled Preview:** “Not live” retains the primary silhouette at 55% opacity, uses a not-allowed cursor, and does not lift or compress.

### Chips

Ticker chips are compact identifiers, not ornamental tags: 52px by 32px on wide screens and 46px wide on compact screens, with Mint Soft fill, Turquoise Action text, 9px corners, and 760-weight Geist. Preview and contract-status badges are full pills with the same mint/turquoise relationship.

### Cards / Containers

- **Corner Style:** Navigation, market, and risk surfaces use 18px corners; mechanism tiles use 24px.
- **Background:** Navigation and market surfaces use translucent Paper Surface; risk surfaces use translucent Mint Soft; mechanism tiles use Table Frost.
- **Shadow Strategy:** Only the navigation and main market surface receive exterior ambient lift.
- **Border:** Risk and mechanism surfaces use one translucent turquoise hairline; table divisions use Mint Line.
- **Internal Padding:** Market cells use 28px horizontal padding and the risk panel uses 22px by 26px; both tighten on compact screens.

### Navigation

The top bar is a sticky 64px paper shell. The AI-generated Dockyard mark and Qubic Grid wordmark anchor the left, Geist routes occupy the center, and network plus wallet state occupy the right. Inactive links use Quiet Slate; the active route switches to Teal Ink and receives a 3px Turquoise Action underline. At 760px and below, route links and network text hide while brand and wallet action stay visible.

### Market Table

The market list is one continuous fixed-layout paper surface. Its 11px uppercase header uses Table Frost and Mint Line separators. Rows are 46px high on wide screens and 54px on compact screens, with a Table Frost hover transition over 160ms ease-out. The market, Max LTV, and Borrow or Not live action remain visible at every supported width; secondary market descriptions hide on compact screens. LTV values use tabular numerals and bold weight.

### Risk and Preview States

The risk note is an explicit Mint Soft panel with a circular paper information mark, a two-level text hierarchy, and a visible explanatory link. On compact screens, the link moves below the copy instead of disappearing. Read-only MVP state adds a cream status notice and replaces market actions with disabled “Not live” controls; no live-contract implication is allowed.

### Mesh Gradient

The signature environmental component is Paper Shaders `MeshGradient`, fixed to the full viewport and non-interactive. It uses Mesh Mist, Sea-Glass Mint, Sea-Glass Green, Mesh Sky, and Mesh Sand with distortion 0.72, scale 1.15, swirl 0.18, grain mixer 0.08, grain overlay 0.015, and speed 0.035. It is capped at 1,600,000 pixels and a minimum pixel ratio of 1. The component starts static until the motion preference is known. With `prefers-reduced-motion: reduce`, speed remains 0 and the deliberate frame at 18000 becomes the final static background; all content and hierarchy remain unchanged.

### Dockyard Logo

The signature logo is the AI-generated protected-channel D with the Qubic Grid Dockyard wordmark. The outer harbor uses Turquoise Action, the entering channel uses Turquoise Bright, and the wordmark uses Teal Ink. Its accessible name is “Dockyard.” rUSD may appear as a minted coin icon in borrowing flows, but it is never substituted for the protocol logo.

## Do's and Don'ts

### Do:

- **Do** identify the protocol as Dockyard and rUSD as the stablecoin it issues.
- **Do** keep primary workflows within the centered 1040px frame and preserve breathing room around the display promise.
- **Do** use the Paper Shaders mesh as the full-viewport ambient field and freeze it for reduced-motion users.
- **Do** use Turquoise Action for primary interaction hierarchy, Turquoise Bright for wave and flow geometry, and Mint Soft for supportive emphasis.
- **Do** keep financial data in continuous, scan-friendly structures with fine Mint Line separators.
- **Do** use Qubic Grid for the promise, Dockyard wordmark, and compact section signage; keep navigation, actions, prose, and numeric data in Geist.
- **Do** preserve the AI-generated protected-channel D across the wordmark and favicon.
- **Do** pair risk, network, and preview status color with explicit language and visible keyboard focus.
- **Do** allow internal `rusd-` CSS class and token prefixes to remain where renaming would create implementation churn; keep them invisible to users.

### Don't:

- **Don't** call the protocol rUSD; rUSD is the borrowed currency.
- **Don't** reintroduce contour lines, topographic maps, pointer-reactive backgrounds, or hard chart-like paths.
- **Don't** turn the interface into a wide, dense exchange terminal or a black corporate dashboard.
- **Don't** use glossy foreground gradients, layered hard shadows, or multiple depth effects on one surface.
- **Don't** scatter pills, cards, or accent colors across data that reads more clearly as a table.
- **Don't** hide liquidation, oracle, market-closure, preview, or testnet state behind color alone.
- **Don't** copy Liquity or Robinhood marks, typography, or brand geometry.
- **Don't** use anchors, ships, ropes, bank buildings, or safe-door pictograms as Dockyard identity.
