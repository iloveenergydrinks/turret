---
name: "Dockyard"
description: "A sea-glass borrowing desk for turning tokenized equity collateral into USDG liquidity."
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
    fontFamily: "Figtree Variable, Avenir Next, Arial, sans-serif"
    fontSize: "clamp(50px, 4.75vw, 72px)"
    fontWeight: 650
    lineHeight: 0.98
    letterSpacing: "-0.03em"
  mobile-display:
    fontFamily: "Figtree Variable, Avenir Next, Arial, sans-serif"
    fontSize: "clamp(44px, 13vw, 60px)"
    fontWeight: 650
    lineHeight: 0.98
    letterSpacing: "-0.03em"
  lead:
    fontFamily: "Figtree Variable, Avenir Next, Arial, sans-serif"
    fontSize: "clamp(17px, 2vw, 20px)"
    fontWeight: 400
    lineHeight: 1.55
  market-title:
    fontFamily: "Figtree Variable, Avenir Next, Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1
  title:
    fontFamily: "Figtree Variable, Avenir Next, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.55
  body:
    fontFamily: "Figtree Variable, Avenir Next, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  navigation:
    fontFamily: "Figtree Variable, Avenir Next, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 660
  action:
    fontFamily: "Figtree Variable, Avenir Next, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 700
  label:
    fontFamily: "Figtree Variable, Avenir Next, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.08em"
  metadata:
    fontFamily: "Figtree Variable, Avenir Next, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  info-mark:
    fontFamily: "Figtree Variable, Avenir Next, Arial, sans-serif"
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
    padding: "0 18px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.turquoise-action-hover}"
    textColor: "{colors.paper-surface}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
  account-button:
    backgroundColor: "{colors.turquoise-action}"
    textColor: "{colors.paper-surface}"
    rounded: "12px"
    padding: "0 18px"
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

Dockyard turns isolated Stock Token markets into one approachable borrowing desk. A slowly shifting sea-glass field establishes place, while a narrow centerline of white work surfaces, deep turquoise controls, and blue-green ink keeps the product practical. The atmosphere is maritime through light, tide-like motion, and the protected central berth inside the safe-harbor mark—not through anchors, ships, rope, or decorative nautical scenery.

The protocol is Dockyard; USDG is the existing dollar-denominated token users borrow from an owner-funded vault. Dockyard does not issue or mint USDG. Dockyard owns the navigation, logo, shell, and overall visual world. USDG appears as the output currency in the borrowing mechanism, balances, debt, and repayment. Internal CSS custom properties and class names may retain the `rusd-` prefix for implementation stability; that prefix is not user-facing identity and must never be used to rename the protocol in copy or visual assets.

The system is narrow, friendly, and direct. It inherits Liquity V1's approachable simplicity without copying Liquity or Robinhood identity. It refuses exchange-terminal density, black corporate panels, glossy fintech spectacle, and the rejected contour-line background. The approved background is the Paper Shaders `MeshGradient`, kept low-contrast and subordinate to risk comprehension and borrowing actions.

**Shipped reference:** The implemented home surface follows approved Option B (`.impeccable/mocks/dockyard-home-option-b.png`) with the user's mesh-gradient revision. Finish-review disposition: **ship**; all material fixes are resolved.

**Key Characteristics:**

- A single 1040px frame with an asymmetrical first viewport and compact information surfaces.
- One oversized, plain-language Figtree promise paired with a deep-teal illustrative position composer.
- A living sea-glass mesh behind translucent paper surfaces, never contours or pointer-reactive effects.
- Fine mint separators, rounded practical controls, and one quiet ambient depth device per surface.
- An AI-generated safe-harbor mark built from four rounded dock modules protecting a central berth.
- Explicit risk, preview, and network language that never relies on color alone.

## Colors

The palette combines a deep turquoise action voice with misted mint surfaces and a restrained five-color sea-glass shader.

### Primary

- **Turquoise Action** (`#08786E`): The sole primary interaction color for buttons, active navigation, links, focus identity, the Dockyard dock lines, and mechanism icons.
- **Turquoise Action Hover** (`#05675F`): The darker pointer-hover response for primary actions.
- **Turquoise Bright** (`#0FAE9B`): The mechanism connectors and other restrained flow geometry; use it as geometry, not small text on white.
- **Favicon Wave** (`#8EF0DC`): A reserved light accent for compact brand applications; it is not used inside the current monochrome mark.

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

**Display and Body Font:** Figtree Variable (with Avenir Next, Arial, and sans-serif fallbacks)

**Character:** Figtree gives Dockyard a fluid, open voice without the industrial grid character of the discarded display face. Its broad apertures keep small financial labels clear while its variable weights give the promise and wordmark enough authority to share one coherent typographic system.

### Hierarchy

- **Display** (690, `clamp(58px, 6.5vw, 84px)`, 0.94): The dominant Figtree promise on wide screens, with `-0.04em` tracking. At 760px and below it becomes `clamp(48px, 14.2vw, 66px)`.
- **Lead** (400, `clamp(17px, 2vw, 20px)`, 1.55): Short literal explanation under the display statement, balanced and capped at 620px.
- **Market Title** (680, 22px, 1): Compact section signage in Figtree; it becomes 20px on compact screens.
- **Title** (700, 15px, 1.55): Emphasis inside explanatory surfaces and market names.
- **Body** (400, 14px, 1.55 where prose needs it): Market data and practical interface copy in Figtree.
- **Navigation** (660, 14px): Figtree route labels with an open, stable rhythm.
- **Action** (700, 13px): Borrow actions, flow labels, and explanatory links.
- **Label** (700, 11px, `0.08em`): Uppercase table headings only.
- **Metadata** (400, 12px): Secondary market, network, and footer copy; ticker identifiers increase weight to 760.

### Named Rules

**The Plain Promise Rule.** Let one short, high-contrast display line carry the page; supporting copy stays smaller, calmer, and literal.

**The Protocol-and-Currency Rule.** Set “Dockyard” as the protocol wordmark and shell identity. Set “USDG” as the borrowed asset, never as the product name or a token issued by Dockyard.

**The Practical Label Rule.** Uppercase and wide tracking belong to table metadata, not body copy or calls to action.

## Layout

The spatial model is one narrow centerline: a fluid frame capped at 1040px and inset 16px per side on wide screens. The first viewport is an asymmetrical control deck: the promise sits left and one deep-teal position preview sits right. The fixed, full-viewport shader remains behind the shell; data and risk content stay left-aligned for scanning.

The top bar uses a three-column grid so the Dockyard brand, centered route navigation, and account state balance without widening the content. A condensed three-move rail—choose, deposit, borrow—bridges the hero and market list. The ten markets remain one continuous fixed-layout table rather than splitting into cards.

At 900px, the hero stacks while keeping the position preview capped at 560px. At 760px, the frame inset tightens from 16px to 10px, the top bar becomes a 56px two-column shell, and the borrowing rail stacks vertically. The market table preserves ticker, Max LTV, and Preview action, hides company metadata, narrows numeric and action columns, and keeps 54px rows.

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

The Dockyard mark is an AI-generated safe harbor refined through reference-led identity exploration. Four rounded deep-teal dock modules converge around a protected central berth, creating one compact symbol without a letterform or literal maritime illustration. The lowercase Figtree “dockyard.” wordmark sits to its right. The same transparent raster mark is used for the favicon, navigation, and a faint structural watermark inside the position preview; the 512px web asset and high-resolution original are preserved under `public/brand/`.

**The Protected Berth Rule.** The logo uses four equal visual masses around one central negative-space berth; do not add lettering, anchors, ships, rope, portholes, or decorative waves.

**The Soft Structure Rule.** Use roundness to soften clear structure, not to turn every label or data cell into a pill.

## Components

### Buttons

Buttons feel compact, direct, and responsive.

- **Shape:** Working controls use 10–16px corners; reserve full pills for compact status only. Market Borrow actions use 10px corners and transaction actions use 16px corners.
- **Primary:** Transaction and account actions use Paper text on Turquoise Action. Market Borrow actions use a sea-glass mint fill, turquoise text, and one low-contrast turquoise keyline so repeated rows stay calm.
- **Hover / Focus / Active:** Hover darkens primary actions, inverts market actions to Turquoise Action, and lifts enabled controls by 1px over 160ms ease-out. Active controls settle down by 1px. Keyboard focus uses a 3px translucent turquoise outline with a 3px offset.
- **Preview Selection:** Read-only market actions remain enabled as “Preview” so they can update the illustrative composer. The actual transaction action inside that composer is disabled and explicitly says “Contracts not live.”

### Chips

Ticker chips are compact identifiers, not ornamental tags: 52px by 32px on wide screens and 46px wide on compact screens, with Mint Soft fill, Turquoise Action text, 9px corners, and 760-weight Figtree. Preview and contract-status badges are full pills with the same mint/turquoise relationship.

### Cards / Containers

- **Corner Style:** Navigation, market, and risk surfaces use 18px corners; mechanism tiles use 24px.
- **Background:** Navigation and market surfaces use translucent Paper Surface; risk surfaces use translucent Mint Soft; mechanism tiles use Table Frost.
- **Shadow Strategy:** Only the navigation and main market surface receive exterior ambient lift.
- **Border:** Risk and mechanism surfaces use one translucent turquoise hairline; table divisions use Mint Line.
- **Internal Padding:** Market cells use 28px horizontal padding and the risk panel uses 22px by 26px; both tighten on compact screens.

### Navigation

The top bar is a sticky 64px paper shell. The AI-generated safe-harbor mark and Figtree wordmark anchor the left, Figtree routes occupy the center, and network plus wallet state occupy the right. Inactive links use Quiet Slate; the active route switches to Teal Ink and receives a 3px Turquoise Action underline. At 760px and below, route links and network text hide while brand and wallet action stay visible.

### Market Table

The market list is one continuous fixed-layout paper surface. Its 11px uppercase header uses Table Frost and Mint Line separators. Rows are 46px high on wide screens and 54px on compact screens, with a Table Frost hover transition over 160ms ease-out. Each ticker appears only once, followed by its company name and “Isolated market” metadata. Read-only rows use Preview/Selected actions and a stronger selected state; LTV values use tabular numerals and bold weight.

### Borrow Workspace

The standalone borrowing route names one selected Stock Token in the headline and explicitly identifies Robinhood Chain mainnet with its chain ID. Collateral input, USDG output, borrowing limits, vault liquidity, position balances, and the atomic full-repayment exit share one narrow two-column workspace. A bare `/borrow` route resolves to AAPL, while each explicit market route reads live state from the deployed vault.

### Earn Desk

Public Earn deposits are not enabled for the standalone USDG vault. The current Earn route states that liquidity is owner supplied and does not expose deposit actions until share accounting, withdrawal rights, and yield distribution exist.

### Risk and Preview States

The risk note is an explicit Mint Soft panel with a circular paper information mark and a two-level text hierarchy. Read-only state is consolidated into the top-bar “Preview · not live” badge, the composer’s disabled “Contracts not live” action, and the concluding “Preview · contracts pending” status; no duplicate cream notice or live-contract implication remains.

### Mesh Gradient

The signature environmental component is Paper Shaders `MeshGradient`, fixed to the full viewport and non-interactive. It uses Mesh Mist, Sea-Glass Mint, Sea-Glass Green, Mesh Sky, and Mesh Sand with distortion 0.72, scale 1.15, swirl 0.18, grain mixer 0.08, grain overlay 0.015, and speed 0.035. It is capped at 1,600,000 pixels and a minimum pixel ratio of 1. The component starts static until the motion preference is known. With `prefers-reduced-motion: reduce`, speed remains 0 and the deliberate frame at 18000 becomes the final static background; all content and hierarchy remain unchanged.

### Dockyard Logo

The signature logo is the AI-generated four-part safe-harbor mark with the lowercase Figtree “dockyard.” wordmark. The mark uses Turquoise Action and the wordmark uses Teal Ink. Its accessible name is “Dockyard.” USDG may appear as the borrowed asset in transaction flows, but it is never substituted for the protocol logo.

## Do's and Don'ts

### Do:

- **Do** identify the protocol as Dockyard and USDG as existing liquidity supplied to its vault.
- **Do** keep primary workflows within the centered 1040px frame and preserve breathing room around the display promise.
- **Do** use the Paper Shaders mesh as the full-viewport ambient field and freeze it for reduced-motion users.
- **Do** use Turquoise Action for primary interaction hierarchy, Turquoise Bright for wave and flow geometry, and Mint Soft for supportive emphasis.
- **Do** keep financial data in continuous, scan-friendly structures with fine Mint Line separators.
- **Do** use the Figtree variable family across promise, wordmark, controls, prose, and numeric data; hierarchy comes from scale and weight rather than a second display face.
- **Do** preserve the AI-generated four-part safe-harbor mark across the wordmark and favicon.
- **Do** pair risk, network, and preview status color with explicit language and visible keyboard focus.
- **Do** allow internal `rusd-` CSS class and token prefixes to remain where renaming would create implementation churn; keep them invisible to users.

### Don't:

- **Don't** imply that Dockyard issues or mints USDG; it lends USDG already held by the vault.
- **Don't** reintroduce contour lines, topographic maps, pointer-reactive backgrounds, or hard chart-like paths.
- **Don't** turn the interface into a wide, dense exchange terminal or a black corporate dashboard.
- **Don't** use glossy foreground gradients, layered hard shadows, or multiple depth effects on one surface.
- **Don't** scatter pills, cards, or accent colors across data that reads more clearly as a table.
- **Don't** hide liquidation, oracle, market-closure, preview, or testnet state behind color alone.
- **Don't** copy Liquity or Robinhood marks, typography, or brand geometry.
- **Don't** use anchors, ships, ropes, bank buildings, or safe-door pictograms as Dockyard identity.
