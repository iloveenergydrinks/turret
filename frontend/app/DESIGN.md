---
name: "rUSD"
description: "A friendly, narrow credit desk for borrowing against tokenized equities."
colors:
  turquoise-action: "#08786E"
  turquoise-action-hover: "#05675F"
  turquoise-bright: "#0FAE9B"
  mint-field: "#F0FAF8"
  paper-surface: "#FFFFFF"
  teal-ink: "#102B2A"
  quiet-slate: "#5A7270"
  mint-line: "#D8EAE6"
  mint-soft: "#DDF5F0"
  table-frost: "#F7FCFB"
  testnet-amber: "#D97645"
typography:
  display:
    fontFamily: "Bricolage Grotesque Variable, Arial Narrow, sans-serif"
    fontSize: "clamp(50px, 4.75vw, 72px)"
    fontWeight: 720
    lineHeight: 0.94
    letterSpacing: "-0.035em"
  lead:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "clamp(17px, 2vw, 20px)"
    fontWeight: 400
    lineHeight: 1.55
  title:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.55
  body:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
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
  icon-label:
    fontFamily: "Bricolage Grotesque Variable, Arial Narrow, sans-serif"
    fontSize: "12px"
    fontWeight: 700
  info-mark:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "21px"
    fontWeight: 750
rounded:
  ticker: "9px"
  control: "10px"
  mobile-shell: "14px"
  mobile-icon: "15px"
  surface: "18px"
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
    typography: "{typography.action}"
    rounded: "{rounded.ticker}"
    width: "52px"
    height: "32px"
  info-panel:
    backgroundColor: "{colors.mint-soft}"
    textColor: "{colors.teal-ink}"
    rounded: "{rounded.surface}"
    padding: "22px 26px"
---

# Design System: rUSD

## Overview

**Creative North Star: "The Friendly Credit Desk"**

rUSD presents collateralized borrowing as a short, understandable conversation at a calm credit desk. Its pale mint field, paper-white work surfaces, deep turquoise actions, and teal-black typography make sophisticated financial mechanics feel approachable without making risk feel casual.

The system is narrow, friendly, and direct. It borrows the approachable spirit of Liquity V1, but its looped rUSD mark, turquoise-mint world, and Bricolage display voice are original. Interfaces remain compact and readable rather than becoming dense trading terminals, glossy fintech showcases, or black corporate dashboards.

**Key Characteristics:**

- A single centered frame with generous breathing room and compact information surfaces.
- Plain-language hierarchy led by one decisive display statement.
- Pale tonal layering, fine separators, and soft ambient lift.
- Rounded, practical controls with quick state feedback.
- Visible risk language and keyboard focus that never depend on color alone.

## Colors

The palette is a quiet mint-and-teal foundation with one clear turquoise action voice.

### Primary

- **Turquoise Action** (`#08786E`): The sole action color for primary buttons, active navigation, links, and focus identity; it passes AA with white text.
- **Turquoise Action Hover** (`#05675F`): A darker response reserved for pointer hover and pressed emphasis on primary actions.
- **Turquoise Bright** (`#0FAE9B`): A decorative brand signal for the loop mark and flow connectors, never small text on white.

### Neutral

- **Mint Field** (`#F0FAF8`): The full-page ground; it keeps white surfaces distinct without the severity of gray.
- **Paper Surface** (`#FFFFFF`): The floating top bar, market panel, information icon, and high-clarity text-on-accent color.
- **Teal Ink** (`#102B2A`): The dominant text and interactive ink for headlines, market symbols, and active navigation.
- **Quiet Slate** (`#5A7270`): Secondary copy, inactive navigation, network labels, and footer text.
- **Mint Line** (`#D8EAE6`): Fine table rules and quiet divisions.
- **Mint Soft** (`#DDF5F0`): Ticker chips, risk surfaces, and focused tonal states.
- **Table Frost** (`#F7FCFB`): Header rows, mechanism surfaces, and row-hover feedback inside paper surfaces.
- **Testnet Amber** (`#D97645`): The compact testnet status dot; it is paired with a text label rather than carrying meaning alone.

### Named Rules

**The One Action Voice Rule.** Turquoise Action carries the primary interaction hierarchy; Turquoise Bright is reserved for non-text brand geometry.

**The Risk Is More Than Color Rule.** Status color must be paired with explicit text, a label, or another perceivable cue.

## Typography

**Display Font:** Bricolage Grotesque Variable (with Arial Narrow and sans-serif fallbacks)

**Body Font:** Geist (with Arial and sans-serif fallbacks)

**Character:** Bricolage Grotesque gives promises, actions, navigation, and market names a friendly, slightly compressed voice with recognisable curves. Geist remains the body and numeric workhorse so dense financial data stays stable.

### Hierarchy

- **Display** (720, `clamp(50px, 4.75vw, 72px)`, 0.94): The dominant Bricolage promise on wide screens, using 91% width and optical sizing with tight tracking (`-0.035em`). On narrow screens it shifts to `clamp(44px, 13vw, 60px)` at 88% width.
- **Lead** (400, `clamp(17px, 2vw, 20px)`, 1.55): Short explanatory copy beneath a display statement, held to a readable 620px maximum.
- **Title** (700, 15px, 1.55): Compact emphasis inside explanatory surfaces.
- **Body** (400, 14px): Market data and practical interface copy in Geist.
- **Action** (700, 13px): Compact Bricolage action links, flow labels, and primary row controls.
- **Label** (700, 11px, `0.08em`): Uppercase table headings only; the spacing supports scanning at a small size.
- **Metadata** (400, 12px): Secondary market, network, and footer copy in Geist.

### Named Rules

**The Plain Promise Rule.** Let one short, high-contrast display line carry the page; supporting copy stays smaller, calmer, and literal.

**The Practical Label Rule.** Uppercase and wide tracking belong to table metadata, not body copy or calls to action.

## Layout

The spatial model is one narrow centerline: a fluid frame capped at 1040px and inset 16px per side on wide screens. Primary page sections use an 18px vertical rhythm, while the main region carries 28px top and 48px bottom padding. The hero is centered, but data and explanatory content remain left-aligned for scanning.

The top bar uses a three-column grid so branding, navigation, and account state balance without widening the content. Market data stays in one continuous fixed-layout table rather than splitting into a card grid. The mechanism uses three equal visual steps joined by restrained arrows.

At the single implemented breakpoint (`760px`), the frame inset tightens to 10px, the top bar becomes a two-column shell, navigation and the testnet label hide while the account action remains, and the market table preserves ticker, LTV, and Borrow action. Hero type and mechanism icons scale down; the information panel and footer reflow rather than shrinking into dense rows.

**The One Centerline Rule.** Brand, message, mechanism, market list, risk note, and footer align to the same capped frame.

## Elevation & Depth

The system is lifted but ambient. White surfaces rise from Mint Field with a single diffuse teal-gray shadow: the sticky top bar uses `0 8px 28px rgba(15, 68, 63, 0.08)`, and the larger market panel uses `0 10px 34px rgba(15, 68, 63, 0.09)`. Mint tonal fills and fine rules carry secondary hierarchy without adding elevation.

### Shadow Vocabulary

- **Ambient Navigation** (`0 8px 28px rgba(15, 68, 63, 0.08)`): Low lift for the sticky white top bar.
- **Ambient Panel** (`0 10px 34px rgba(15, 68, 63, 0.09)`): Slightly broader lift for the continuous market surface.

### Named Rules

**The One Depth Device Rule.** A surface may use one ambient shadow or tonal separation; never stack hard borders, multiple shadows, and glow on the same surface.

## Shapes

The form language is gently rounded and consistent. Primary floating surfaces use 18px corners; compact actions use 10px, ticker chips use 9px, and the mobile top bar tightens to 14px. The account control is a full pill, while status dots and the information marker are circular. Borders are 1px and low contrast; they divide information rather than boxing every element.

Mechanism and logo artwork use rounded line caps and exact product-specific geometry: stacked market cards, a hexagonal collateral aperture, and a minted rUSD coin. These curves make the system approachable without falling back to generic bank or safe symbols.

**The Soft Structure Rule.** Use roundness to soften clear structure, not to turn every text label or data cell into a pill.

## Components

### Buttons

Buttons feel compact, direct, and responsive.

- **Shape:** Borrow actions use gently rounded 10px corners; the account action uses a full pill.
- **Primary:** Paper text on Turquoise Action. Row actions are at least 88px by 36px with 16px horizontal padding; the medium account action is 40px high with 14px horizontal padding.
- **Hover / Focus:** Hover darkens to Turquoise Action Hover and lifts row actions by 1px over 140ms ease-out. Keyboard focus uses a 3px translucent turquoise outline with a 3px offset on branded controls.
- **Secondary / Tertiary:** Secondary theme buttons use Mint Soft with turquoise text; tertiary buttons keep the same text color over a transparent ground and gain a soft mint hover fill.

### Chips

Ticker chips are compact identifiers, not ornamental tags: 52px by 32px on wide screens, 46px wide on narrow screens, with Mint Soft fill, Turquoise Action text, 9px corners, and bold tabular-feeling labels.

### Cards / Containers

- **Corner Style:** Primary floating and explanatory surfaces use 18px corners.
- **Background:** Market and navigation surfaces use Paper Surface; explanatory surfaces use Mint Soft and mechanism tiles use Table Frost.
- **Shadow Strategy:** Only the navigation and main market surface receive ambient lift.
- **Border:** Explanatory panels use one translucent turquoise border; table divisions use Mint Line.
- **Internal Padding:** Market cells use 28px horizontal padding, while the risk panel uses 22px by 26px. Both tighten on narrow screens.

### Navigation

Navigation is a centered, 64px-tall desktop strip inside a sticky white surface. Bricolage links are 14px and weight 660 in Quiet Slate; the active link switches to Teal Ink and receives a 3px Turquoise Action underline. At 760px and below, primary links and the text network state hide, while the logo and account action remain in a 56px shell.

### Market Table

The market list is one continuous, fixed-layout paper surface. Its 11px uppercase header uses Table Frost and Mint Line separators. Rows are 46px high on wide screens and 54px on narrow screens, with a Table Frost hover state over 160ms ease-out. The market, max-LTV value, and Borrow action remain visible at every supported width; secondary market descriptions hide on narrow screens.

### Risk Note

The risk note is an approachable but explicit Mint Soft panel. A circular paper information mark anchors a two-level text hierarchy, its consequential copy stays at 14px, and the Bricolage explanatory link remains visible; on narrow screens the link moves beneath the copy instead of being removed.

### rUSD Mark

The signature mark is an original rounded line that loops from collateral-like enclosure into an open path, paired with a compact Bricolage rUSD wordmark. Turquoise Bright carries the mark and Teal Ink carries the name; it must not imitate Liquity or Robinhood identity assets.

## Do's and Don'ts

### Do:

- **Do** keep primary workflows within the centered 1040px frame and preserve breathing room around the display promise.
- **Do** use Turquoise Action for the primary interaction hierarchy, Turquoise Bright for non-text brand geometry, and Mint Soft for supportive emphasis.
- **Do** keep financial data in continuous, scan-friendly structures with fine Mint Line separators.
- **Do** use Bricolage Grotesque for promises, navigation, actions, and compact market names; keep long copy and tabular data in Geist.
- **Do** pair risk and network status color with explicit language and visible keyboard focus.
- **Do** keep motion to fast hover, focus, and press feedback between 50ms and 160ms.

### Don't:

- **Don't** turn the interface into a wide, dense exchange terminal or a black corporate dashboard.
- **Don't** use glossy gradients, layered hard shadows, or multiple depth effects on one surface.
- **Don't** scatter pills, cards, or accent colors across data that reads more clearly as a table.
- **Don't** hide liquidation, oracle, market-closure, or testnet state behind color alone.
- **Don't** copy Liquity or Robinhood marks, typography, or brand geometry.
- **Don't** use generic bank, classical-building, or safe-door pictograms for the collateral mechanism.
