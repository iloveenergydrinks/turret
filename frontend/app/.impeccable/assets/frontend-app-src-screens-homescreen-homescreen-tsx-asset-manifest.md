# rUSD Home / Markets Asset Manifest

Approved mock: `../mocks/rusd-v1-narrow-approved.png` (1536 × 1024)

Implementation evidence:

- `../../src/screens/HomeScreen/HomeScreen.tsx`
- `../../src/comps/Logo/Logo.tsx`
- `../../src/comps/AppLayout/TopBar.tsx`
- `../../src/comps/AppLayout/BottomBar.tsx`
- `../../src/app/brand.css`
- `../screenshots/rusd-desktop.png` (1280 × 900)
- `../screenshots/rusd-mobile.png` (390 × 844)

Inventory result: no production raster assets are required for this surface. The approved visual world is deliberately made from type, inline SVG, semantic HTML, and CSS-owned surfaces. Mock pixels remain reference-only and are not shipped.

## Produce

None.

## Direct

None.

## Semantic

### `brand-lockup`

- implementation: Render the original looped rUSD mark and wordmark as one accessible inline SVG in `Logo.tsx`. SVG owns the mark path, dot, and wordmark; the top-bar link owns sizing, color, and focus treatment. Keep the vector responsive and do not rasterize the approved-mock logo.
- notes: Compared with the approved mock and both implementation captures. The deployed lockup preserves the required looped silhouette and semantic vector role; exact stroke and wordmark styling are implementation-owned.
- qa_status: `accepted`

### `top-navigation-and-account`

- implementation: Build the white floating header with semantic `header`, `nav`, links, network-status text and dot, and the wallet account control. CSS owns the centered 1040px frame, 18px/14px responsive radius, low-contrast border, ambient shadow, active underline, spacing, and mobile navigation collapse.
- notes: No standalone visual source is needed. The desktop and mobile captures confirm that the wallet action remains visible while primary navigation collapses on mobile.
- qa_status: `accepted`

### `hero-message`

- implementation: Use semantic heading and paragraph elements for the product promise and explanatory line. CSS owns responsive type sizing, two-line balance, deep-navy/periwinkle-gray palette, center alignment, spacing, and the narrow readable measure.
- notes: Text must stay live for accessibility and responsive wrapping. No lettering or background treatment should be baked into an image.
- qa_status: `accepted`

### `collateral-to-rusd-mechanism`

- implementation: Compose three labeled HTML steps with inline SVG icons for Stock Token, Vault, and rUSD, plus inline SVG arrows between them. CSS owns icon-tile size, pale-lavender fill, periwinkle stroke/color, rounded corners, grid spacing, and mobile scaling. Keep all SVGs decorative with accessible meaning supplied by the containing group label and visible step labels.
- notes: The implementation uses simplified semantic symbols rather than copying pixels from the mock. The structure, palette, visual role, and responsive sequence match the approved direction without requiring raster art.
- qa_status: `accepted`

### `market-panel-and-table`

- implementation: Render the collateral chooser as one semantic section containing a heading, explanatory copy, live market count, and an HTML table with scoped column headers and data-backed rows. CSS owns the continuous white surface, border, 18px radius, ambient shadow, header band, separators, column widths, row hover, numeric alignment, and responsive column preservation.
- notes: Market values remain live text. The implementation intentionally expresses each company as a ticker badge and text metadata instead of shipping corporate-logo crops from the generated mock. This is consistent with the surface brief's semantic-table requirement and avoids unlicensed or blurry mock-derived marks.
- qa_status: `accepted`

### `market-ticker-badges`

- implementation: Build each ticker badge as a styled `span` inside the market-name cell. CSS owns the 52 × 32px desktop and 46 × 32px mobile footprint, lavender fill, periwinkle text, 9px radius, weight, and truncation behavior for adjacent metadata.
- notes: These badges replace the comp's illustrative company marks with crisp, data-driven semantic labels. No raster or external logo fetch belongs in this surface.
- qa_status: `accepted`

### `borrow-actions`

- implementation: Use accessible links for one Borrow action per market. CSS owns compact dimensions, periwinkle fill, white label, 10px radius, keyboard focus ring, hover color, and the small upward hover motion.
- notes: Controls remain semantic and interactive; no button artwork is required.
- qa_status: `accepted`

### `risk-note`

- implementation: Build the isolated-risk explainer as an `aside` with a CSS-drawn circular information mark, semantic strong/body copy, and a text link. CSS owns the soft-lavender panel, subtle border, 18px radius, icon circle, three-column desktop layout, and two-column mobile reflow.
- notes: The visible risk copy must remain selectable and screen-reader accessible. The panel's color and chrome are layout properties, not raster content.
- qa_status: `accepted`

### `footer`

- implementation: Use a semantic `footer` with live protocol disclaimer text and utility links. CSS owns the shared centerline, top divider, muted type, spacing, and stacked mobile layout.
- notes: No footer illustration, seal, or logo raster appears in the approved surface.
- qa_status: `accepted`

### `page-field-and-surface-chrome`

- implementation: Create the pale-lavender page field, restrained radial tint, white panel backgrounds, borders, radii, and quiet shadows entirely in CSS variables and component rules. Keep radius, shadow, clipping, and responsive layout out of any bitmap.
- notes: Visual comparison confirms that the background and card treatment are simple CSS effects with no intrinsic texture or photographic detail to extract.
- qa_status: `accepted`

## Execution order

No `produce` work is needed. The craft implementation should compose the semantic roles in this order: page field and shared frame; header and brand; hero message; mechanism; market panel, rows, and actions; risk note; footer.

## Blockers

None.

## Assumptions

- The surface brief's explicit `Raster assets: None required` decision is authoritative for the asset medium.
- The ticker-badge treatment is an intentional semantic substitute for the generated mock's illustrative company marks, not a missing asset.
- Existing repository images and SVGs used by other screens are outside the rUSD home/markets surface and are not part of this manifest.
