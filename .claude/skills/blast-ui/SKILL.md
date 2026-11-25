---
name: blast-ui
description: Blast web UI standard. Load it before building, changing or reviewing any user-facing UI or CSS in apps/web (pages, components, sheets, styles, copy), so new work composes the shared library and keeps the approved 2026-10-27 identity.
---

# Blast UI standard

Every Blast screen is **composed** from one library in `apps/web/src/components/blast-ui` and one token set in `blast-ui.css`. A page decides content and order. It never decides how a tab, field, button, empty state, pager or colour looks.

The decisions and their provenance live in [`docs/design-system/BLAST-DESIGN-SYSTEM.md`](../../../docs/design-system/BLAST-DESIGN-SYSTEM.md), which is the single source of truth. Read its "Approved direction and provenance" (2026-10-27) and "Page-level parts" sections before your first UI change in a session. The approved canvas is https://claude.ai/artifact/AYvi7UAZ6AFkbVKgPRnGMk.

For a site-wide pass on concise dates, icons, and semantic color, use [Blast frontend review](../../../.agents/skills/blast-frontend-review/SKILL.md).

## Steps

1. **Name the decision.** Say what the person decides on this screen and which facts they need. Anything that serves neither is cut: captions that narrate the UI, repeated figures, decoration nobody asked for. Done when every element on the screen maps to a fact or an action.
2. **Compose from the library.** Use the table below. If no primitive fits, or the change adds key, scroll, viewport or form behaviour, run [Platform first](../../../apps/web/AGENTS.md#platform-first) before you build: the browser may already do it. Then add the variant to the shared primitive. Done when the change adds no hand-built tab row, field frame, chevron, empty state, pager, or styled `<a>`/`<button>`.
3. **Style with tokens only.**
   - Colours: `var(--ink|--ink-2|--muted|--card|--raised|--chip|--track|--action|--up|--down|--warn|--info…)`.
   - Corners: `--r-inner` 7, `--r-button` 10, `--r-sm` 14, `--r-md` 22.
   - Lengths use rem (board px ÷ 16). Desktop keeps the browser's root size. At widths up to 760px, the root uses `clamp(1rem, 4.1026vw, 1.125rem)`. Use px for hairlines (≤ 1.5px), media queries and touch rules (44px targets, 16px input text).
   - Motion: `--t1`…`--t4` with `--ease-std` (`--ease-io` for on-screen movement, `--ease-drawer` for sheets); script imports `blast-ui/motion-tokens.ts`.
   - If a visual need is missing, add a variant to the shared primitive instead of local CSS.
   - Done when the diff has no new hex colour, px radius or ad-hoc shadow outside `blast-ui/`.
4. **Check every state.** Cover loading (shared skeletons), empty only after a confirmed read (`EmptyState`), error with recovery (`EmptyState role="alert"` plus a retry Button), and the data itself. Missing optional figures are omitted together with their label. Done when each state renders, or is proven by a test.
5. **Run the guard.**
   - From the repo root: `npx eslint <changed files>` (the `blast-ui/shared-patterns` and `shared-controls` rules) and `node --test scripts/shared-patterns.test.mjs`.
   - The ledgers in `scripts/eslint/*-legacy.json` and `scripts/shared-patterns-css-legacy.json` may only shrink. Lower them when you remove a legacy pattern; never raise them.
   - Done when both pass with the ledgers unchanged or lower.
6. **See it.**
   - Capture the real page at 320, 407, 768, 1054 and 1414 px, in light and dark.
   - Use the PR's Vercel preview or a local dev server; with no data locally, use the preview.
   - Check one left content edge, no overflow, 44px touch targets, visible neutral focus, and reduced motion.
   - Done when every changed route has captures at all five widths in both themes.
7. **Get an independent review.**
   - A different model reviews the captures and diff, and reports findings as a `Before | After | Why` table ranked P0–P3.
   - Resolve every P0–P2. Fix each P3 or list it as a follow-up.
   - Done when the review has no open P0–P2.

## The library

| Need | Use | Never |
| --- | --- | --- |
| Tabs, single choice, view switch | `Segmented` (`tabs`, `tabId`/`panelId`, `optionDisabled`, `size` `sm` 28 / `md` 32 / `chip` 36, `stretch`) | `role="tablist"` or `.seg` markup in a feature |
| Tabs that are places (URL) | `SegmentedLinks` (`tabs`, `onNavigate`, per-item `id`/`controls`, `stretch`) | links styled as tabs by hand |
| Action | `Button` (`primary` / `secondary` / `ghost` / `danger` / `positive` / `ink`; `xs` 28, `sm` 32, `chip` 36 for the top bar, `md` 40, `lg` 52), `IconButton` | `.btn` classes on new code |
| Icon-only place, copy | `IconButtonLink` (`size` `chip` 36, `touch` 44); `CopyButton` (`variant` ghost/secondary/primary, `size`) | an icon in a styled `<a>`, a hand-built copy chip |
| Rail row, coin picker | `Button` / `DisclosureButton` with `variant="nav"` (`size="lg"`: the avatar row) or `variant="picker"` | a hand-styled row or pill |
| Place that looks like an action | `ButtonLink` | `<Link className="btn …">` |
| Dropdown, menu, select, coin picker, disclosure | `DisclosureButton` (Base UI `render`; `chevron={false}` for a plain chip; `variant="picker"` for coins), `SelectField` | a hand-drawn chevron SVG |
| Money action (Swap, Launch, Publish) | `Button`: one press starts the action | a countdown, a confirm dialog or an acknowledgement checkbox |
| A step's secondary settings | `FoldList`, `FoldSection`, `useFold` (`social/create/fields.tsx`): one row per card showing its value | a new step, a stack of always-open cards |
| Text input, search, amount with prefix or Max | `TextField`, `FieldGroup` (`size` `md` 40 search, `lg` 44 forms), `TextArea` (`resize`) | a bordered wrapper with its own focus ring |
| Checkbox, on/off | `Checkbox` inside a `<label>`, `Switch` (both from `Checkbox.tsx`; on is ink) | `accent-color`, a hand-built toggle |
| Empty, not-found, couldn't-load | `EmptyState` (`title` with no trailing period, one sentence, one `action`, `framed`, `role`, `heading`) | `.empty`, ad-hoc "No … yet." blocks |
| Pagination | `Pager` (`pages` or `hasMore`; `alwaysShow` keeps a single page) | Previous/Next markup |
| Page title | `PageHeader` | a bare `<h1>` in a route view |
| Price or amount text | `readablePrice` (lib/market-format.ts), `chartPrice`/`chartNumber` (charts), presale `qm`/`qs`/`saleMoney` | `toPrecision`, `toExponential`, `e-` output |
| Chart | KLineCharts (`components/charts/kline`) for the coin page chart; TradingView Lightweight Charts components in `components/charts` elsewhere | a third chart library |
| Trading venue (Cetus, Bluefin, Aftermath) | `DexIdentity` icon with an accessible name (`size` 16–24); where the person picks a venue, `DexIdentity` with its name beside the icon | the venue's name as plain text without the icon |

## Rules that bite

- **Selection and focus.** Use a neutral thumb or tonal fill with ink text. Use `var(--focus-color)` for focus rings.
- **Primary action.** Reserve pink (`--action` with white text) for the primary action in each context. Use neutral tokens for persistent controls and badges.
- **Data series.** Use ink for the main series. Use `splitShades` in visible segment order and repeat those shades in the legend. Keep segments 2px apart and at least 0.5rem wide.
- **A box has a fill or a border, never both.** Cards are a fill (plus the dark lit top edge), with no hairline ring. Rows in a card are set apart by space, not hairlines. No box inside a card where space works: figure tiles (curve, token split) and fold bodies are unboxed.
- **Groups are spaced 2× their inner gap:** a step's cards 2rem apart around 1rem field gaps; the swap money sentence at least 16px below the field above it.
- **No repeated facts:** a card and the summary beside it never state the same figure twice. Readiness lists only the to-do items. A note is at most about 16 words; under 40 explanatory words per phone screen.
- **Money actions start on one press.** Swap submits when the executable quote is ready. If the quote is below the minimum shown, show the new price and wait for a fresh press. Editing or closing before the quote arrives cancels that request. Launch and presale Publish start signing immediately. Put the amount, direction, worst case and any terms that lock in one sentence directly above the action, using at most 25 words. Show "Successful" as soon as the trade confirms and hold it for at least 4 s. If the executable quote fails, wait for a fresh press. An estimate can retry after a service outage (Retry-After or 5 s).
- **Secondary settings fold into rows that show their value:** a step keeps its main card open and folds each secondary card into one row ("Buyer vesting · 6 mo, 1-mo cliff", label at most six words) that opens in place. Rows are plain (no border or fill, one hairline between, 44px, visible focus) and each value fits one line at 390px. A shown error or a fix opens its row, so errors are never hidden. Defaults and validation stay; no new steps.
- **Tickers and amounts are never cut:** one `.ticker` class (blast-ui.css) keeps a ticker whole when it fits and breaks it only when it cannot (never clip, ellipsis or overflow), also inside a sentence (`TickerText`, box at `min-width: 0`); write it `$PIP` in every flow, with signing labels from one source for the review list and the sheet. A coin chip is as wide as its ticker (about eight characters in full); a long money amount fits its type to the space available (`AmountFit`) instead of hiding digits. An amount and its unit or ticker never wrap apart: join them with a no-break space ("9.5M PIP"); a long ticker still breaks inside itself.
- **Owner exceptions** (owner rulings, 2026-11-14): leave the presale publish 3D scene (`CreateLaunchScene`) and its rocket celebration as they are, and keep the Back buttons in the step flows (audit finding TS-7 is accepted).
- **Review folds too** (owner ruling, 2026-11-14): each Review group is one `ReviewFold` row with a short value ("Splits · Buyers 45%, pool 30%"), the signatures the last row (`SignaturesFold`, "Signatures · 3 in your wallet"). Review never opens a group by itself: a missing or wrong value is named in its row in `--warn` ("Splits · Team wallet missing"); the form steps still open theirs. The first buy is a Review row too ("First buy · 100 SUI", or "None"; a press opens its input; a wrong amount is named in the row in `--warn`), with no estimate line: the money sentence says what you pay and get, and it is never folded. A value cell's whole value is one inline span, so a ticker sits one space after its amount. The name and ticker are the hero, not a row; no row holds more than three numbers, the creator's share first.
- **Shares read as set:** a fee or token share is never rounded to a different number (Blast's 2.5% is 2.5%, not 3%): `pct`/`pctText`; whole-percent `share` is only for curve projections.
- **Disabled text is readable:** a disabled primary's words are `--muted` on `--track` (4.77:1 light, 5.85:1 dark), never `--faint`; refreshing text stays `--muted`; a switch's off track has a `--muted` edge (3:1 or more against the card).
- **The current step is ink, not pink:** in step lists the active icon is `--ink` with `--bg` inside and no edge. An open signing sheet is never idle ("Opening your wallet…", step 1 in progress). Copy ends in full stops, never exclamation marks, with curly apostrophes (’).
- **Sticky primary on phones:** below 760px a long form's primary action uses the shared `cr-sticky-action` class, sticky above the tab bar and in the flow, placed after the step's cards; the bar is opaque `--bg` edge to edge, with the sheet button area's top fade (1.3125rem) so nothing under it is sliced.
- **Say what is missing:** a disabled primary action keeps its short verb ("Swap") and has one reason line next to it naming the gaps ("Add a team wallet … to publish.", "Not enough SUI for this amount."), in every off state (no amount, a failure, no route, wallet not ready; a waiting trade reads "Swapping…" with what it waits for); signed out it reads "Sign in"; a wallet fee goes in the money sentence, never the label; no "+" or "↑" glyphs in labels. Empty optional review rows stay blank. Every shown error carries its code as a muted second line (`DiagnosticText`, `.err-code`); a load error is the title plus the code line only (`DiagnosticCode`), unless its sentence says more than the title; a failure toast passes `tone: "error"` and stays until dismissed; say what was kept exactly once per screen (a paused sheet: one muted "Your progress is saved." under the steps; the error says only what failed, "Publishing could not finish." plus its code; the button carries the retry). Flow errors never say "saved" or a bare "retry"; only a message shown where there is no note (a toast with the sheet closed, the page's off line) says what was kept. The paused sheet has no subtitle and its scene no caption (the title, banner and steps say the state; scene words would fall under 12px); the error, steps, note and button show without scrolling at 390x844 and 1280x800.
- **Loading waits 300 ms:** an indicator or skeleton appears only after `--t4` (300 ms), so fast answers never flash one; a skeleton takes the populated card's layout and size. A waiting button keeps its label; its accessible name says what it waits for.
- **No placeholder as data:** a required value that is missing, loading or failed shows the muted `—` (`NO_VALUE` from `@blast/core/web/format.ts`), never a zero, a sample like "Ticker", or filler in data styling. One dash glyph: `—`.
- **One Edit path, the stepper:** review and summary screens carry no per-group Edit links.
- **A disabled primary says why:** one line beside it (linked with `aria-describedby`) names only what is missing, e.g. "Add a name and a logo to launch."
- **Rarely changed options fold:** put them behind one collapsed `DisclosureButton` ("Advanced …") whose label notes the current values; it opens itself when a shown error is inside. Green and red mark price moves, PnL, and the labeled swap directions in Launch activity. Use `--warn` for to-dos and neutral ink for “Successful”. A preview card shows at most three numbers; one to-do per missing thing. Stage colours come from `.status` with `data-tone`.
- **Hierarchy:**
  - page titles are 36/650 at -.04em, line-height 1.05 (32/650 at 1.1 on phones), the System board's page title, always through `PageHeader`;
  - section headers above a card are 20/650;
  - titles inside a card are 17/650;
  - labels are 12–13px `--muted`, sentence case;
  - hero figures use the display face with tabular numerals.
- **Money:**
  - Presale amounts read in the raise coin ("91,280 SUI", "102,500 USDC"). Prices read in dollars with subscript zeros (`$0.0₈182`).
  - Never round a nonzero balance to zero, and never show a figure twice on a screen.
- **Covers** are stored at 3:1 (1536 × 512) and shown at 3:1, or 2:1 on phones. Keep logos inside the centre safe area.
- **Layout:**
  - Views align to one left content edge: the rail (248px) plus the 40px page gutter (18px on phones). The page is at most 1180px; a right column is 300px, 20px from the view.
  - The shell owns the frame (Rail, Topbar and Mobile boards): the 64px top bar (52px header row on phones), the title block 26px under it with 20px before the first card (`--page-title-top`, `--page-title-gap`; a board with another gap sets the variable on its page root), and the docked phone tab bar. Pages never redraw any of it. Follow the design system’s [shell geometry](../../../docs/design-system/BLAST-DESIGN-SYSTEM.md#approved-direction-and-provenance) for navigation. Collapsed, the rail keeps a 12px label under every icon; it is never icons only, except the Blast links (X, Telegram, map, docs) at its foot (owner, 2026-11-20). No text under 12px, key hints included.
  - Group with tonal cards and whitespace, not divider lines.
  - Below 760px, toolbars wrap and segmented rows stretch. A stretched row that can't fit its labels scrolls sideways; never shrink or abbreviate labels to fit.
- **Honest lists:** a failed read never says "no coins". While service health says lists are late, Home and Bonding show `ListsLate` (one page-level line with Try again) and hide sections with no rows (an `EmptyState` with `listEmpty`, or a `PendingPanel`); an empty the person caused (a search, a filter, their own launches) keeps its own words. One failed health poll after a fresh healthy read is not late. A list with no rows drops rows per page, the count, sort, Live, the pager and unused filters; the window, an active filter and a live search stay. A hero value slot holds the value or nothing, and the range switch and chart appear only when some range has a line (or the chosen range is loading or failed). One primary per sheet: on a coin, Trade.
- **Structure** (2026-11-14):
  - A tab row offers at most three choices. Fold a fourth into one of them; do not add a tab.
  - A rail destination has no back bar. A popover has one leading action and a ghost Close.
  - An error or an empty result says what happened in one sentence, and offers a retry only when a retry can help.
  - A row that opens nothing is plain text, not a dead button or link.
- **Data gaps:** when the server lacks data a design needs, omit the element. Add a row to [`docs/design-system/REDESIGN-DATA-GAPS.md`](../../../docs/design-system/REDESIGN-DATA-GAPS.md) and add no new backend read from a UI change.
