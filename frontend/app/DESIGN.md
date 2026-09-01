---
name: "rUSD"
description: "A friendly, narrow credit desk for borrowing against tokenized equities."
colors:
  periwinkle-action: "#5A50E8"
  periwinkle-action-hover: "#4940D2"
  lavender-field: "#F5F4FF"
  paper-surface: "#FFFFFF"
  midnight-ink: "#11142F"
  quiet-slate: "#676B87"
  lavender-line: "#E3E3F1"
  lavender-soft: "#EEECFF"
  table-frost: "#FAFAFF"
  testnet-amber: "#DC6B2F"
typography:
  display:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "clamp(48px, 4.5vw, 68px)"
    fontWeight: 760
    lineHeight: 0.98
    letterSpacing: "-0.04em"
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
    backgroundColor: "{colors.periwinkle-action}"
    textColor: "{colors.paper-surface}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.periwinkle-action-hover}"
    textColor: "{colors.paper-surface}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
  account-button:
    backgroundColor: "{colors.periwinkle-action}"
    textColor: "{colors.paper-surface}"
    rounded: "{rounded.pill}"
    padding: "0 14px"
    height: "40px"
  market-panel:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.midnight-ink}"
    rounded: "{rounded.surface}"
    width: "100%"
  ticker-chip:
    backgroundColor: "{colors.lavender-soft}"
    textColor: "{colors.periwinkle-action}"
    typography: "{typography.action}"
    rounded: "{rounded.ticker}"
    width: "52px"
    height: "32px"
  info-panel:
    backgroundColor: "{colors.lavender-soft}"
    textColor: "{colors.midnight-ink}"
    rounded: "{rounded.surface}"
    padding: "22px 26px"
---

# Design System: rUSD

## Overview

**Creative North Star: "The Friendly Credit Desk"**

rUSD presents collateralized borrowing as a short, understandable conversation at a calm credit desk. Its pale lavender field, paper-white work surfaces, periwinkle actions, and deep ink typography make sophisticated financial mechanics feel approachable without making risk feel casual.

The system is narrow, friendly, and direct. It borrows the approachable spirit of Liquity V1, but its looped rUSD mark and periwinkle-lavender world are original. Interfaces remain compact and readable rather than becoming dense trading terminals, glossy fintech showcases, or black corporate dashboards.

**Key Characteristics:**

- A single centered frame with generous breathing room and compact information surfaces.
- Plain-language hierarchy led by one decisive display statement.
- Pale tonal layering, fine separators, and soft ambient lift.
- Rounded, practical controls with quick state feedback.
- Visible risk language and keyboard focus that never depend on color alone.

## Colors

The palette is a quiet lavender-and-ink foundation with one clear periwinkle action voice.

### Primary

- **Periwinkle Action** (`#5A50E8`): The sole brand action color for primary buttons, active navigation, links, the looped logo mark, flow diagrams, and focus identity.
- **Periwinkle Action Hover** (`#4940D2`): A darker response reserved for pointer hover and pressed emphasis on primary actions.

### Neutral

- **Lavender Field** (`#F5F4FF`): The full-page ground; it keeps white surfaces distinct without the severity of gray.
- **Paper Surface** (`#FFFFFF`): The floating top bar, market panel, information icon, and high-clarity text-on-accent color.
- **Midnight Ink** (`#11142F`): The dominant text and interactive ink for headlines, market symbols, and active navigation.
- **Quiet Slate** (`#676B87`): Secondary copy, inactive navigation, network labels, and footer text.
- **Lavender Line** (`#E3E3F1`): Fine table rules and quiet divisions.
- **Lavender Soft** (`#EEECFF`): Ticker chips, mechanism icons, secondary surfaces, and focused tonal states.
- **Table Frost** (`#FAFAFF`): Header rows and row-hover feedback inside paper surfaces.
- **Testnet Amber** (`#DC6B2F`): The compact testnet status dot; it is paired with a text label rather than carrying meaning alone.

### Named Rules

**The One Action Voice Rule.** Periwinkle Action carries the primary interaction hierarchy; do not introduce a competing brand accent for routine actions.

**The Risk Is More Than Color Rule.** Status color must be paired with explicit text, a label, or another perceivable cue.

## Typography

**Display Font:** Geist (with Arial and sans-serif fallbacks)  
**Body Font:** Geist (with Arial and sans-serif fallbacks)

**Character:** One modern sans-serif family keeps the product direct and familiar. Personality comes from scale, density, and weight contrast rather than decorative typefaces.

### Hierarchy

- **Display** (760, `clamp(48px, 4.5vw, 68px)`, 0.98): The dominant promise on wide screens, with tight negative tracking (`-0.04em`) and balanced wrapping. On narrow screens it shifts to `clamp(42px, 13vw, 60px)`.
- **Lead** (400, `clamp(17px, 2vw, 20px)`, 1.55): Short explanatory copy beneath a display statement, held to a readable 620px maximum.
- **Title** (700, 15px, 1.55): Compact emphasis inside explanatory surfaces.
- **Body** (400, 14px): Market data and practical interface copy.
- **Action** (700, 13px): Compact action links, flow labels, and primary row controls.
- **Label** (700, 11px, `0.08em`): Uppercase table headings only; the spacing supports scanning at a small size.

### Named Rules

**The Plain Promise Rule.** Let one short, high-contrast display line carry the page; supporting copy stays smaller, calmer, and literal.

**The Practical Label Rule.** Uppercase and wide tracking belong to table metadata, not body copy or calls to action.

## Layout

The spatial model is one narrow centerline: a fluid frame capped at 1040px and inset 16px per side on wide screens. Primary page sections use an 18px vertical rhythm, while the main region carries 28px top and 48px bottom padding. The hero is centered, but data and explanatory content remain left-aligned for scanning.

The top bar uses a three-column grid so branding, navigation, and account state balance without widening the content. Market data stays in one continuous fixed-layout table rather than splitting into a card grid. The mechanism uses three equal visual steps joined by restrained arrows.

At the single implemented breakpoint (`760px`), the frame inset tightens to 10px, the top bar becomes a two-column shell, navigation and the testnet label hide while the account action remains, and the market table preserves ticker, LTV, and Borrow action. Hero type and mechanism icons scale down; the information panel and footer reflow rather than shrinking into dense rows.

**The One Centerline Rule.** Brand, message, mechanism, market list, risk note, and footer align to the same capped frame.

## Elevation & Depth

The system is lifted but ambient. White surfaces rise from Lavender Field with a single diffuse violet-gray shadow: the sticky top bar uses `0 8px 28px rgba(30, 27, 92, 0.07)`, and the larger market panel uses `0 10px 34px rgba(30, 27, 92, 0.08)`. Lavender tonal fills and fine rules carry secondary hierarchy without adding elevation.

### Shadow Vocabulary

- **Ambient Navigation** (`0 8px 28px rgba(30, 27, 92, 0.07)`): Low lift for the sticky white top bar.
- **Ambient Panel** (`0 10px 34px rgba(30, 27, 92, 0.08)`): Slightly broader lift for the continuous market surface.

### Named Rules

**The One Depth Device Rule.** A surface may use one ambient shadow or tonal separation; never stack hard borders, multiple shadows, and glow on the same surface.

## Shapes

The form language is gently rounded and consistent. Primary floating surfaces use 18px corners; compact actions use 10px, ticker chips use 9px, and the mobile top bar tightens to 14px. The account control is a full pill, while status dots and the information marker are circular. Borders are 1px and low contrast; they divide information rather than boxing every element.

Mechanism and logo artwork use rounded line caps and simple outline geometry. These curves make the system approachable, but they remain precise enough for financial information.

**The Soft Structure Rule.** Use roundness to soften clear structure, not to turn every text label or data cell into a pill.

## Components

### Buttons

Buttons feel compact, direct, and responsive.

- **Shape:** Borrow actions use gently rounded 10px corners; the account action uses a full pill.
- **Primary:** Paper text on Periwinkle Action. Row actions are at least 88px by 36px with 16px horizontal padding; the medium account action is 40px high with 14px horizontal padding.
- **Hover / Focus:** Hover darkens to Periwinkle Action Hover and lifts row actions by 1px over 140ms ease-out. Keyboard focus uses a 3px translucent periwinkle outline with a 3px offset on branded controls.
- **Secondary / Tertiary:** Secondary theme buttons use Lavender Soft with periwinkle text; tertiary buttons keep the same text color over a transparent ground and gain a soft lavender hover fill.

### Chips

Ticker chips are compact identifiers, not ornamental tags: 52px by 32px on wide screens, 46px wide on narrow screens, with Lavender Soft fill, Periwinkle Action text, 9px corners, and bold tabular-feeling labels.

### Cards / Containers

- **Corner Style:** Primary floating and explanatory surfaces use 18px corners.
- **Background:** Market and navigation surfaces use Paper Surface; explanatory and mechanism surfaces use Lavender Soft.
- **Shadow Strategy:** Only the navigation and main market surface receive ambient lift.
- **Border:** Explanatory panels use one translucent periwinkle border; table divisions use Lavender Line.
- **Internal Padding:** Market cells use 28px horizontal padding, while the risk panel uses 22px by 26px. Both tighten on narrow screens.

### Navigation

Navigation is a centered, 64px-tall desktop strip inside a sticky white surface. Links are 14px and weight 650 in Quiet Slate; the active link switches to Midnight Ink and receives a 3px Periwinkle Action underline. At 760px and below, primary links and the text network state hide, while the logo and account action remain in a 56px shell.

### Market Table

The market list is one continuous, fixed-layout paper surface. Its 11px uppercase header uses Table Frost and Lavender Line separators. Rows are 46px high on wide screens and 54px on narrow screens, with a Table Frost hover state over 160ms ease-out. The market, max-LTV value, and Borrow action remain visible at every supported width; secondary market descriptions hide on narrow screens.

### Risk Note

The risk note is an approachable but explicit Lavender Soft panel. A circular paper information mark anchors a two-level text hierarchy, and the explanatory link remains visible; on narrow screens the link moves beneath the copy instead of being removed.

### rUSD Mark

The signature mark is an original rounded line that loops from collateral-like enclosure into an open path, paired with a heavy Geist rUSD wordmark. Periwinkle Action carries the mark and Midnight Ink carries the name; it must not imitate Liquity or Robinhood identity assets.

## Do's and Don'ts

### Do:

- **Do** keep primary workflows within the centered 1040px frame and preserve breathing room around the display promise.
- **Do** use Periwinkle Action for the primary interaction hierarchy and Lavender Soft for supportive, non-blocking emphasis.
- **Do** keep financial data in continuous, scan-friendly structures with fine Lavender Line separators.
- **Do** pair risk and network status color with explicit language and visible keyboard focus.
- **Do** keep motion to fast hover, focus, and press feedback between 50ms and 160ms.

### Don't:

- **Don't** turn the interface into a wide, dense exchange terminal or a black corporate dashboard.
- **Don't** use glossy gradients, layered hard shadows, or multiple depth effects on one surface.
- **Don't** scatter pills, cards, or accent colors across data that reads more clearly as a table.
- **Don't** hide liquidation, oracle, market-closure, or testnet state behind color alone.
- **Don't** copy Liquity or Robinhood marks, typography, or brand geometry.
