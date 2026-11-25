# BLAST.FUN interface direction

## Direction

Use calm financial product hierarchy: gray/white tonal surfaces in light mode,
corresponding dark neutrals in dark mode, restrained rounded groups,
clear typography, and generous but purposeful spacing. Use Blast pink for
primary actions and a neutral surface for selection.

- Economics first: identity, price, balance, risk and transaction state outrank
  decoration. Keep related facts and their action adjacent.
- Use one clear emphasis within each decision context. Independent workspace
  panels may each have an actionable primary control; there is no one-button
  limit across the whole workspace.
- Pair color with a text or icon cue for financial sign, permission and
  completion.
- Plain language and immediate feedback build confidence. Decoration must not
  obscure the action, result or recovery path.

### Approved direction and provenance

On 2026-10-27 the user approved a site-wide redesign on the proposal canvas
https://claude.ai/artifact/AYvi7UAZ6AFkbVKgPRnGMk. It covers Home, coin and
presale pages, Portfolio, Presales, Create, Profile, Notifications, Settings,
Competitions, Swap, phones and the shared library sheet.

- **Material.**
  - One surface system for both themes, with Apple-calibrated neutrals. Dark:
    ground `#0a0a0d`, card `#121217`, ink `#f5f5f7`, muted `#98989f`. Light:
    ground `#f5f5f7`, card `#fff`, ink `#1d1d1f`, muted `#6e6e73`.
  - Cards are a fill, plus a lit top edge in dark mode (`--card-lit`); no
    hairline ring (`--sh-1` carries no 1px outline).
  - The top bar is a translucent material.
- **Corners** follow the boards' radius scale (3–26px, written in rem). Use a
  role where it matches: `--r-inner` 7, `--r-button` 10, `--r-sm`/`--r-button-lg`
  14, `--r-md` 22. Other board steps are 9 (sm controls), 11 (rail rows) and
  12 (lg fields). Round shapes are only for avatars, dots, status chips and the
  picker and switch pills.
- **Type.** Page titles are 36/650 at -.04em, line-height 1.05, in the display
  face (32/650 at 1.1 on phones), as the System board's type scale draws them;
  the earlier 34px was a drift. Card section titles are 17/650. Hero figures
  use the display face with tabular numerals.
- **Colour.**
  - One primary action: Blast pink `--action` (`#d61b70`) with white text and
    a subtle depth gradient in both themes. Dark mode presses to `#bf1463`.
  - Selection is a neutral thumb or fill.
  - The rail shows the brand colour only on the selected icon.
  - Persistent chrome is neutral (2026-11-14 design pass, approved by the
    founder): the top bar's Deposit and Create in navigation use the
    neutral control surface, so each page keeps its
    own one pink primary. Account verification uses the ink rosette. The
    deployer badge uses a mini pink Blast helmet beside the coin name or
    ticker. Hovering over it shows “Known Deployer”.
    Write "PnL", never "P&L".
  - Green and red (`--up`, `--down`) mark price moves, PnL, and labeled swap directions in Launch activity. A to-do
    or a missing value is the attention ink (`--warn`); a done action
    ("Successful") is neutral ink, with no glow.
  - Data series are never pink: pink means the action. A split's or chart's
    main series is ink (2026-11-14 design pass).
  - Data series stay in ink and grey, never a hue. A split's shades go by
    place, not by category (`splitShades`): each visible segment takes the
    next of ink, `--ink-tint-2`, `--ink-tint-1`, `--ink-tint-3`, so dark and
    light alternate and neighbours differ by 3:1 or more in both themes
    (values in `blast-ui.css`). Segments sit 2px apart, and a tiny share
    still shows at least 0.5rem wide (2026-11-14 flows pass).
- **Layout.** Views align to one left content edge on every route.
- **Shell geometry** (Rail, Topbar and Mobile boards; tokens in `blast-ui.css`):
  - Rail: 248px (`--rail`; 88px collapsed), 20/16 padding, rows 4px apart. Rows
    are 42px with 12px padding and gap, 11px corners, 15px text at 500 (600
    when current) and 20px icons; every icon and label shares one x.
    The brand row is the helmet mark (36×24, never the bolt) and the 23/700 wordmark
    beside the collapse button (`IconButton size="chip"`); Create is 44px, 18px
    below Portfolio. The rail holds no account control (2026-11-20, owner): the
    account avatar sits in the top bar, where Sign in sits for a visitor.
  - Collapsed rail (2026-11-14, KA-5): every row keeps its name. Each row is a
    80 × 56px cell with the 20px icon over a 12px label, like the phone tab
    bar. The wordmark hides. Every route uses this rail by
    default below 1400px. The user's saved choice applies at every desktop
    width. The Blast links below show icons alone.
  - Blast links (2026-11-20, owner): the rail's foot holds four quiet icon
    links, X, Telegram, the map (map.blast.fun, "How Blast works") and the docs
    (docs.blast.fun), each `IconButtonLink variant="nav"`, opening a new tab and
    named in a tooltip. Full rail: one row of 44px links. Collapsed: a 2 × 2 grid
    of 28px links (one column of 44px on touch). Phones show none.
  - The rail shows Home, Swap, Bonding, Presales, Portfolio and Create.
    Presales uses the ticket icon and links to `/presale`. Bonding uses the
    curve icon and links to `/bonding`. Both pages have their own title.
    Bonding is also current on `/launch` and bonding coin pages. On a not-found page,
    `MissingPageMarker` clears the current item from the first paint.
    Search exposes its `/` shortcut through `title` and `aria-keyshortcuts`.
  - Top bar: 64px, 28px sides, right-aligned 8px apart, all `size="chip"`: the
    Search, the balance, Deposit
    (secondary), the bell and the account avatar (36px; 44px on touch and
    phones), or Sign in for a visitor. Portfolio and Settings, which carry
    their own wallet actions, show no balance or Deposit.
    Without a full total, the balance popover says why in one sentence. It
    offers Try again only when a retry can help (a failed read); View
    portfolio is then the quiet ghost. Missing prices are not an error.
  - Page: at most 1180px (`--page-max`) with 40px gutters (`--page-gutter`),
    so the content edge is the rail plus 40px. A right column is 300px
    (`--aside`), 20px (`--gap`) from the view. Coin trading uses a 360px execution column at its two-column breakpoint so amount fields and quote labels fit. Page titles start 26px under
    the top bar (`--page-title-top`) and keep 20px above the first card
    (`--page-title-gap`).
  - Phones: 18px gutters; one 52px header row (brand, search, notifications,
    account); the balance and Deposit beside the page title;
    a docked tab bar of 54px cells (Home · Swap · Bonding · Presales · More),
    each an icon over a 12px label. The plus icon and Create sit inside More.
- **Venues.** A trading venue (Cetus, Bluefin, Aftermath) shows as its
  `DexIdentity` icon, with the name as accessible text, not as a word.
  Where the person picks a venue (a pool picker, a Raise-in choice), the
  name shows beside the icon (2026-11-14 design pass).
- **Charts.** They stay TradingView Lightweight Charts, styled through
  options: line coloured by the move, a soft area fill, faint grid, muted
  tabular axis text. Prices use subscript zeros from four leading zeros
  (`$0.0₄812`, `$0.0₈182`), never e-notation.
- **Presales.**
  - Cards lead with the cover photo. Raise amounts show in the sale's raise
    coin (SUI or USDC), never `$` for a SUI raise.
  - Covers are stored at 3:1 (1536 × 512), so every cover surface shows 3:1
    (2:1 on phones). Create recommends 3072 × 1024 px, at least 1536 × 512,
    with logos inside the centre safe area.
- **Page structure** (2026-11-14, TS-5, KA-2):
  - A tab row offers at most three choices. Portfolio is Coins · Presales ·
    Claims. Claims holds vesting unlocks, holder rewards, creator earnings
    and your launches; `/portfolio/vestings`, `/rewards` and `/launches`
    redirect to `/portfolio/claims`. The presale catalog is Live · Upcoming ·
    Ended. What you created lives on your profile, and an old `?view=mine`
    link opens it.
  - Your profile is Created · Backed · Activity; someone else's is Backed ·
    Activity. A backed row carries its thesis on one line.
  - A rail destination, your own profile included, has no back bar.
  - A popover has one leading action, and its Close is a ghost button
    (Service status: Refresh, then Close).
  - Search that finds people but no coin says "No coins match “term”." above
    the people.
  - A held coin with no coin page is a plain row, not a control that does
    nothing.
- **Profile** links to Invites.

**Blast Mode design history.** On 2026-10-24 the owner approved Blast pink for
actions, selection and focus in the workspace and its sheets. The 2026-10-27
pass set selection to the shared neutral control surface. Its discovery rail
grouped Coins, Presales, Bonding and Posts, and its overlays and stat tiles reused
existing market data. The 2026-11-22 shell change removed the global entry and
its `B` and `F` shortcuts. [Workspace component guidance](#compact-market-workspace)
still applies where feature pages reuse those panels.

On 2026-10-21 the owner approved the reference image `HUVq5WIX0AAXco6.jpg`
(SHA-256 `1045ba98e161821151c7bc58115237ebb8ab3c68cc4e643c397564ad09d64fb4`)
and explicitly requested its blue accent and light/dark treatment across all UI.
This supersedes the earlier hand-drawn direction and Home/carousel/navigation
visual freeze for this consistency pass. Preserve their behavior and capture
before/after evidence when shared styles affect them.

The owner also requested the Apple design skill (materials, accessibility,
typography and hierarchy) and the Emil design engineering skill (restraint,
responsive controls, purposeful motion and review craft). Apply those principles
to the existing product; the image is not a specification for a circular amount
input, a new payment interaction, financial copy or an animation library.

## Workflow

1. Name the user's decision and the facts required to make it.
2. Reuse this approved direction for the current all-UI pass; no new GPT Image
   generation or approval is required to implement it. For a material departure
   from the approved direction, make the proposed visual change concrete before
   seeking approval.
3. Start with the bounded workspace CSS sample, then calibrate the main shared
   tokens and verified local outliers, the independent launchpad theme, and the
   campaign/access/legal/tool/fallback surfaces. Assign exact files per slice;
   do not treat one shared-token change as a completed all-UI pass.

## Surface, type and control roles

- Bounded scale (component consistency audit, 2026-10-31): desktop text and spacing keep the board size while columns use extra viewport width. This supersedes desktop proportional growth from 2026-10-27; phone scaling and browser text enlargement remain supported.
  - Lengths are rem, the board's px ÷ 16.
  - The Blast UI root follows the viewport:
    - desktop: `1rem`: 16px at the default browser setting, including 1440, 1728 and 1920px viewports;
    - phones (≤ 760px): `clamp(1rem, 4.1026vw, 1.125rem)`: 16px up to the 390px phone board, then up to 18px.
  - The 16px floor keeps the boards' 11–12px labels at their size. Apple's minimums are 10pt on macOS and 11pt on iOS; a strict scale would draw them at 9.8px at 1280. Narrower windows reflow instead: the rail collapses below 1400 and the right column drops below 1220.
  - px stays only for hairlines (≤ 1.5px), media queries and touch rules: 44px targets, and 16px input text so iOS never zooms.
  - `scripts/shared-patterns.test.mjs` fails on any other px length.
  - Tests that pin a geometry read stylesheets through `#web/test/css-design-px.ts`, which writes rem back as design px.
- Match hierarchy across themes: canvas, contained group, raised interactive
  surface and modal layer remain distinguishable. Use tonal separation and
  whitespace before extra borders or shadows. Dense terminal regions can stay
  unboxed. Reserve translucency for useful layering, avoid stacked weak glass,
  and provide solid/high-contrast alternatives.
- Use the existing shared spacing and radius roles. Align each composition's
  content edge and the title, facts and action edges inside a surface. Margins
  adapt to available space; do not enlarge every row or discard workspace/chart
  capacity merely to imitate a phone mockup.
- Build type hierarchy from size, weight and leading together. Keep body text
  legible, display type brief, large figures deliberate and supporting labels
  readable. Tighten tracking only where the size warrants it; allow text
  enlargement and wrapping without losing essential facts or actions.
- Give primary, supporting and destructive controls distinct roles. Specify
  default, hover, active, selected, focus-visible, disabled and busy states in
  both themes; disabled or unknown is not success. Keep compact visual controls
  reachable by touch and keyboard, with effective 44px coarse-pointer targets
  where required. Hover is additional feedback, never the sole access path.
- Active and selected states must never introduce pink borders, outlines or
  rings. Use tonal fills for selection and neutral `--focus-color` /
  `--workspace-focus` tokens for visible keyboard focus. Brand and status fills
  retain their semantic colors. Choose foreground/background pairs by measured contrast,
  including hover and focus: normal text at least 4.5:1, large text 3:1, and
  required control boundaries/focus indication 3:1 against adjacent colors.
  A reference blue hex does not guarantee readable white button text; darken
  the action fill or choose an appropriate foreground where needed.

## Product hierarchy

Coin summaries present identity, economics, state, then action. Transaction
surfaces expose amount, asset, balance, estimated result, price impact, fees,
slippage, and network before signature. Previews are explanatory.

Loading states name the operation. Empty states offer the next useful action.
Errors explain what happened, what remains safe, and how to recover.

A failed read is never an empty list. When service health says the market
source is late, Home and Bonding show one page-level line ("Lists are late.
Your balances are safe.", with Try again) instead of their empty or
still-loading sections; a section with rows stays, and an empty the person
caused (a search, a filter, their own launches) keeps its own words. A list with no
rows drops the tools that only arrange rows: rows per page, the count, sort,
the Live switch, the pager and unused filters. Controls that can change the
result stay as the way out: the window, an active filter, a search in progress.
A hero figure slot holds the value or nothing; a failure becomes one body-size
line in its place that names the cause (a wallet sync, holdings that could not
load with Try again, or no USD price). The value range switch and chart frame
appear only when some range has a line, or the chosen range is still loading or
failed. On a coin,
Trade is the one primary; Deposit and Withdraw are quiet, and the sheet fits
its content.

## Project-specific constraints

- Keep one content edge across top-level routes. Responsive changes alter the
  composition rather than clipping information.
- Pixel-art assets, where retained, resolve to whole CSS pixels; this does not
  impose pixel-art geometry or typography on product controls.
- Charts use the canvas by default. A dark chart requires a product reason such
  as a user-selected theme or a dense terminal intended for extended use.
- Display type is for short emphasis. Japanese text is an occasional low-risk
  arcade accent; navigation, money, risk, and transaction actions remain clear
  in English.
- Celebratory motion, sound, and reaction stamps stay outside financial data and
  persistent status. Audio begins from user intent and remains optional.

## Verification

UI changes require two collaborating agents using different models: an
implementer and an independent reviewer.
Share the Home baseline, exchange concrete findings, and review actual captures
and interaction/state evidence. Resolve material findings before completion;
state unavailable coverage explicitly. Review findings use a Before/After/Why
markdown table. Aim for 10/10 craft in hierarchy,
clarity, consistency, accessible feedback, and purposeful motion. This is a
quality target, never an automatic score or self-certification. Report the
outcome, evidence, and remaining limits concisely.

Verify at 320px, 407px, 768px, 1054px, and 1414px. At every width:

- navigate every top-level product view and compare its content edge;
- confirm no document overflow, clipped action or blurred pixel-art assets;
- complete keyboard-only interaction and preserve visible focus;
- confirm reduced motion preserves every state change; test reduced transparency
  and increased contrast independently; and
- confirm financial information remains legible without relying on color,
  motion, sound, or Japanese text.

Record route/state evidence per slice: direct load and navigation, light/dark,
loaded/loading/error/empty after a successful read where implemented, sheets
and menus with focus return, and financial review/submitted/confirmed/refused
distinctions.
Distinguish actual live observations, fixture results, source inspection and
blocked coverage. Alias/redirect entries and parallel rail slots are not extra
screens. An inventory or a few representative captures cannot establish an
all-UI visual PASS; reconcile remaining routes and shared states before closing
that scope. This standard authorizes no live signature, gate removal or data
mutation merely to obtain visual evidence.

## Mandatory interface acceptance rules

Inspect the actual Home, carousel and navigation baseline, plus the approved
image, before changing shared components. They are included in the all-UI pass,
with the same blue action/focus and tonal hierarchy requirements; preserve their
functionality and verify their resulting layouts rather than keeping their
prior styling frozen.

1. Never use inline expansion to reveal a full address, identifier, exact
   amount, or alternate timestamp. Use a shared inspection overlay.
2. Keep essential information and the primary action visible without disclosure.
   A disabled primary action says why in one line beside it, naming only what
   is missing.
3. Reserve disclosure for meaningful secondary groups, such as contract details
   or longer history. The vesting detail page has no nested accordions. Rarely
   changed form options sit behind one collapsed "Advanced" disclosure that
   names the current values and opens itself on an error inside. A step's
   secondary settings fold into rows (rule 24).
4. Animate retained disclosures deliberately in both directions. Honor reduced
   motion; immediate changes or minimal fades are valid accessibility exceptions.
5. Make information available to keyboard and touch as well as hover.
6. Reuse established tokens and shared components. A page-specific visual system
   requires a concrete need.
7. Keep the primary action visually dominant. Use accent color selectively.
8. Describe actual state plainly. Unknown permission is not confirmed denial;
   a failed check is not a wallet-verification requirement.
9. Keep implementation details outside the primary flow unless they affect a
   user's decision.
10. Preserve exact numeric precision internally. Never round a nonzero balance
    to zero, or count through invented transaction balances.
11. Copy the full underlying value and provide accessible success or failure
    feedback. Keep copy separate from inspection; show a checkmark and “Copied”.
12. UI is complete only after visual checks at desktop and mobile widths,
    keyboard interaction, and reduced motion. Use explicit fixtures for unavailable
    states, and distinguish simulated results from live observations.
13. Separate content sections with tonal groups/cards and whitespace rather than
    decorative divider lines. Reuse established surface and spacing roles; do
    not add a card around every dense chart or table region. Groups are
    spaced twice the gap inside them (MA-2): a step's cards 2rem apart
    around 1rem field gaps, the Review hero 1.5rem from its folds around
    0.75rem inside it, and the swap money sentence at least 16px below the
    field above it.
14. A box has a fill or a border, never both. Rows inside a card are set
    apart by space, not hairlines. No box inside a card where space works:
    figure tiles (a curve's "Starts at / Graduates at", a token split) and a
    fold's body are unboxed text set apart by space, never a filled tile.
15. State each fact once per screen. A card and the summary beside it never
    repeat the same figure; keep it where the decision is made. Readiness
    lists only what is left to do (no meter, no list of done sections: the
    stepper shows those); one to-do per missing thing, however many sections
    need it. A preview card shows at most three numbers (a sale's progress,
    target and price); the rest lives in the summary and the rows. Help lines stay short: a note at most about 16
    words, under 40 explanatory words per phone screen.
16. A money action (Swap, Launch, presale Publish) starts on one press.
    A swap requests its executable quote and submits as soon as it is ready.
    If the quote is below the minimum shown, show the new price and wait for
    a fresh press. Editing or closing before the quote arrives cancels that
    request. One sentence beside the action states the amount, direction and
    worst case in at most 25 words and says which terms lock, where applicable.
    Show "Successful" as soon as the trade confirms and hold it for at least
    4 s before resetting the form. If the executable quote fails, wait for a
    fresh press. An estimate can retry after a service outage
    (`service_unavailable`, `pool_unavailable`) after its Retry-After or
    5 s and says so ("Checking again…").
17. On phones (≤760px) a long form's primary action is sticky: one shared
    class (`cr-sticky-action`) keeps it above the tab bar and in the flow, so
    it never covers the last field. The action row sits after the step's
    cards, on the page background, and the bar is opaque `--bg` from edge to
    edge, so nothing scrolls through around the buttons. Its top edge is the
    sheet button area's fade (1.3125rem, clear to `--bg`), so what scrolls
    under it softens instead of being sliced. At 390 × 844 the last field
    above the bar ends at least 8px above the fade: the folded column's card
    drops its chrome on phones and renders nothing when it would be empty.
18. A disabled primary action keeps its short verb ("Swap", "Publish") and
    says why in one line next to it that names what is missing ("Add a team
    wallet and a treasury wallet to publish.", "Not enough SUI for this
    amount."). This holds in every off state: no amount ("Enter an amount."),
    a failure (its sentence and code), no route, a wallet that did not load
    or is not ready; while a sent trade waits, the button reads its running
    verb ("Swapping…") and the line says what it waits for. Empty optional review rows stay blank. Signed out, the button
    reads "Sign in" and the line still names what is missing. A fee the
    wallet pays goes in the money sentence ("Network fee ≈ 0.002 SUI."),
    never in the button label. Labels carry no "+" or "↑" glyphs ("Add
    recipient", "Upload").
19. Every error shown carries its code (and reference when there is one,
    `docs/errors.md`), as a smaller muted second line under the plain
    sentence: build it with `diagnosticMessage`/`publicErrorMessage` and
    render it with `DiagnosticText` (`.err-code`). Load errors, publish
    errors and sheet errors alike; never a bare sentence. A load error is its
    title plus the code line only (`DiagnosticCode`), never a body that
    repeats the title; a sentence that says more than the title (“Your
    account could not load.”) stays above the code. A failure toast passes `tone: "error"`, so it stays
    until dismissed; info toasts time out. Say what was kept
    exactly once per screen: a paused signing sheet has one muted line under
    its steps ("Your progress is saved."), the error banner says only what
    failed ("Publishing could not finish." plus its code line), and the
    button carries the retry. No flow error says "saved" or a bare "retry";
    only a message shown where no such note is (a toast with the sheet
    closed, the page's off line) says what was kept. The paused sheet has no
    subtitle and its scene no caption (the title, banner and steps say the
    state; words in the scaled scene would fall under 12px). The error, the steps, the
    note and the button show without scrolling at 390x844 and 1280x800.
20. A loading indicator appears only after 300 ms (`--t4`); faster answers
    never flash one. A skeleton waits the same 300 ms and takes the populated
    card's own layout and size (the launch Coin card's fields drawn as
    boxes), so nothing moves when the data arrives. A button that is waiting keeps its label and says what it
    waits for in its accessible name.
21. No placeholder is rendered as data. A required value that is missing,
    loading or failed shows the muted dash `—` (`NO_VALUE`), never a zero, a
    sample ticker ("Ticker") or filler text in data styling.
22. One Edit path: the stepper. Review and summary screens list terms without
    per-group Edit links; the person goes back through the stepper.
23. One dash glyph: the em dash `—` (`NO_VALUE` in `@blast/core/web/format.ts`)
    for every missing value.
24. Secondary settings fold into rows that show their value. A step keeps its
    main card open; each secondary card becomes one plain row in a single card
    (no border or fill of its own, one hairline between rows, 44 px tall, a
    visible focus ring), its label at most six words and its value short enough
    for one line at 390 px ("Buyer vesting · 6 mo, 1-mo cliff", "Who can join ·
    Anyone, 30,000 max"). Pressing the row opens it in place (`FoldList`, `FoldSection`,
    `useFold`). Defaults and validation do not change: a row with a shown
    error, or one a fix sends the person to, opens itself. No new steps.
    Review folds the same way (owner ruling, 2026-11-14): each group (Coin,
    Curve, Splits, Fees …) is one row with a short value ("Splits · Buyers
    45%, pool 30%", `ReviewFold`), and the wallet's signatures are its last
    row ("Signatures · 3 in your wallet", `SignaturesFold`). Review never
    opens a group by itself, so it fits one 390x844 screen: a group with a
    missing or wrong value names it in its row in the attention ink
    (`--warn`, 6.11:1 light, 11.17:1 dark; "Splits · Team wallet missing"),
    and a press opens it. The first buy is a Review row too ("First buy ·
    100 SUI", or "None"): a press opens its input, and an amount over the
    balance or under the minimum is named in the row in the attention ink.
    No estimate line repeats the money sentence, which is the one place that
    says what you pay and get. The money sentence above the button is never
    folded. The name and ticker
    are the hero, not a row as well. No review row holds more than three
    numbers, the creator's share first. A value cell is a flex box, so its
    whole value is one inline run: a ticker sits one space after its amount.
25. A ticker is one shared class (`.ticker` in `blast-ui.css`): it stays whole when it fits
    its line and breaks anywhere only when it cannot. It is never clipped, cut
    to an ellipsis or pushed past its card. `Ticker` renders one; `TickerText`
    sets each ticker inside a sentence (the money sentences), whose box takes
    `min-width: 0`. Write it as `$PIP` in every flow
    ("Create $PIP", "Publish $MRDN"), and a signing step reads the same in the review list and the signing sheet (one label source per flow). A money amount is never cut either: its
    type scales to the width available in the swap field (`AmountFit`). An amount and its unit
    or ticker never wrap apart: a no-break space joins them ("9.5M PIP",
    "100 SUI"); a long ticker still breaks inside itself.
26. Owner exceptions (owner rulings, 2026-11-14), kept as they are and not
    judged against the restraint rules above: the presale publish 3D scene
    (`CreateLaunchScene`) and its rocket celebration, at its current
    length; the Back buttons in the step flows (audit finding TS-7 is
    accepted). Review groups folding into rows is also an owner ruling (rule 24).
27. A fee or token share reads as set, never rounded to a different number:
    Blast's 2.5% shows 2.5%, not 3% (`pct`, `pctText`). Whole-percent
    rounding (`share`) is only for figures the curve projects.
28. A disabled primary button's words are often the only reason it is off,
    so they meet 4.5:1: `--muted` on `--track` (4.77:1 light, 5.85:1 dark),
    never `--faint` (2.18:1, 2.81:1). Text that refreshes in place (a rate
    being asked again) stays `--muted` too. A switch's off track carries a
    `--muted` edge so it reaches 3:1 against the card.
29. In a step list (signing and publishing sheets) the current step's icon
    is ink with the page colour inside and no edge, never pink; done steps
    are the chip fill with a check. An open sheet is never idle: before the
    first step reports, it says "Opening your wallet…" and marks step 1 in
    progress. Copy uses full stops, never exclamation marks, and curly
    apostrophes (’) in every user-facing string.

For vesting, show identity, current status, available balance, beneficiary, and
claim together. Claimed, total allocation, and locked are secondary metrics.
Fully unlocked does not mean fully claimed. Keep cancellation configuration,
wallet authority, schedule eligibility, loading, unknown, and failures separate.
Keep timing, next releases, current cancellation permissions and authorized
management actions visible without opening technical metadata. Ordinary dates
are plain semantic text; reserve inspection for genuinely omitted precision.
Never infer authority from a recipient address. Show exact amounts in transaction
review, preserve the signing checks, and use visibly labelled UTC unless an app
timezone setting exists. Completion dates are text, not dropdowns.

BLAST motion defaults use `--t1` (120 ms), `--t2` (200 ms), `--t3` (280 ms), `--t4`
(300 ms) and `--ease-std` (the strong ease-out; `--ease-io` for on-screen movement,
`--ease-drawer` for sheets and sidebars; script reads the same values from
`blast-ui/motion-tokens.ts`): roughly 120–180 ms for feedback and 180–240 ms for
secondary disclosures, and 300 ms at most for UI motion. Keep
frequent keyboard actions immediate, transitions interruptible and input usable;
no decorative bounce/counting through financial values. These timings and the
single-value disclosure ban are product decisions.

Money figures update in place, instantly (owner, 2026-10-28).

### Apple guidance and BLAST decisions

Apple's [layout](https://developer.apple.com/design/human-interface-guidelines/layout),
[motion](https://developer.apple.com/design/human-interface-guidelines/motion),
[disclosure controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls),
and [accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
guidance informs hierarchy, consistency, purposeful feedback, adaptable layouts,
and accessible interaction. Apple supports progressive disclosure for relevant
secondary content. The stricter acceptance rules above are BLAST requirements;
the approved image above now supplies the visual direction. Apple/Emil guidance
does not override financial truth, accessibility or the existing lifecycle rules.

## Shared controls across the website

### Page-level parts (2026-10-27)

Every route composes these from `apps/web/src/components/blast-ui` and never
hand-rolls them.

- **`Segmented` / `SegmentedLinks`**: every tab row and single choice.
  - Renders the `.seg` track with the neutral sliding thumb.
  - `tabs` gives a tablist with roving focus and arrow keys.
  - Links carry `aria-current`, so the URL stays the source of truth.
  - Segments are 32px with 16px sides and 13/600 text, sized to their labels (`sm`: 28px, 12px sides). `stretch` fills the container with equal segments while the labels fit; a tighter row sizes segments to their labels, then scrolls sideways.
  - Icon segments keep a 16px glyph.
- **`EmptyState`**: empty, not-found and couldn't-load messages.
  - Contents: a short title (no trailing period), at most one sentence and at
    most one action.
  - Use `framed` when nothing else frames it, and `role="alert"` for failures.
  - Show it only after a read confirms nothing exists.
- **`Pager`**: pagination.
  - Previous, page numbers (when the total is known) or "Page N" (cursor
    `hasMore`), then Next.
  - It renders nothing for a single page unless `alwaysShow`. A page is a button, never a link.
- **Fields.** `TextField` and `FieldGroup` draw the edge and the focus ring
  inside the field. A prefix, an icon, a suffix or a Max button sits in the
  same frame, so focus and errors never detach from the edge. `FieldGroup size`:
  `md` 40 with 12px sides (search) or `lg` 44 with 12px corners and 14px sides
  (forms); without a size the frame follows its input.
- **Dropdown triggers.** Menus, selects, coin pickers and disclosures use
  `DisclosureButton` or `SelectField`. The 16px chevron is built in and turns
  when open; features never draw their own arrow.
- **`ButtonLink`**: a navigation that looks like an action ("All presales",
  "View coin"). It has Button's variants, sizes and states with link semantics,
  and replaces hand-styled `.btn` links.
- **`Checkbox` and `Switch`.** Checked is ink, never pink, and features never
  restyle a native checkbox with `accent-color`. The whole label is the 44px
  target. `Switch` (exported from `Checkbox.tsx`) is the 46 × 28 `role="switch"`
  pill with a 22px knob.

ESLint `blast-ui/shared-patterns` enforces these for production TSX:
- no raw `.seg` or `.empty` markup, and no hand-built `role="tablist"`, outside the primitives;
- no hand-drawn chevron path inside a trigger;
- no `SegThumb` import outside blast-ui.

`scripts/shared-patterns.test.mjs` enforces the CSS side:
- no pink on selected, current or pressed states in CSS modules;
- no corner radius outside the roles and the boards' radius scale.

Both use per-file ledgers that may only shrink.

On 2026-10-26 the user requested Blast colors for the shared controls across the
website. This supersedes blue defaults for these shared components; financial
success/error colors keep their meaning.

All new web UI uses the shared controls in `apps/web/src/components/blast-ui`.
This applies to every route, sheet and popup. Existing feature adapters calculate
permissions, pending state and business facts; primitives receive presentation
props and callbacks. Generic controls do not import queries, wallets, transaction
logic or feature components. The architecture evidence and migration order are in
[Uniswap frontend patterns](UNISWAP-FRONTEND-PATTERNS.md).

```tsx
import { Button, IconButton, DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { Checkbox } from "#web/components/blast-ui/Checkbox.tsx";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";

<Button variant="primary" size="lg" disabled={!canSubmit}
  loading={busy} loadingLabel="Buying coin" onClick={review}>Buy</Button>
<IconButton aria-label="Close portfolio" onClick={close}><CloseIcon /></IconButton>
<label><Checkbox checked={shown} onChange={changeShown} />Show trades</label>
<FieldGroup><span aria-hidden="true">$</span>
  <TextField aria-label="Amount" inputMode="decimal" value={amount} onInput={editAmount} />
  <Button size="xs" onClick={useMax}>Max</Button>
</FieldGroup>
```

- Button variants: primary, positive, secondary, ghost, danger, ink, segment, nav, picker. Positive
  is the semantic green trade action, with theme-specific contrast tokens. Ink is the
  owner-approved emphasis that is not the context's action ("Continue with X"). Segment is for
  controls inside a shared track; existing tab keyboard/ARIA behavior stays in
  its feature or headless adapter. Nav is a rail row (42px, 12px padding and gap, 11px
  corners; `size="lg"` is the 50px avatar row, the coin sheet's coin row). Picker is the coin picker pill.
- Sizes: sm 32 (9px corners), md 40 (10px), lg 52 (14px) and chip 36; xs 28 (7px)
  stays for compact controls. Chip is the top bar's: 12px sides, 10px corners, 13px
  text and an 18px icon glyph; a primary chip has 16px sides. Coarse-pointer targets
  grow to 44 (lg 52).
- Geometry and state styling live in `Controls.module.css`: attached focus
  outlines (zero gap), field-group focus, icon insets, radii, disabled/busy activation,
  pointer targets and reduced-motion/forced-colors handling. Icon-only actions use
  IconButton: a 16px glyph (18px at chip) centred in a square of the control height
  (44px on coarse pointers), with protected inset space. Labelled controls use shared horizontal padding. Layout classes
  may place or stretch controls; they must not redefine those invariants.
  Add a shared variant when a repeated visual need is missing.
- Expandable chevron controls use `DisclosureButton`, including Base UI render adapters.
  Use `iconOnly` with an accessible name for a standalone chevron; the default
  40px target contains a centered 16px glyph (44px on coarse pointers). Labelled
  controls accept children and an optional `leadingIcon`, and share normal Button sizes. Native `aria-expanded`
  owns direction. Features must not supply or rotate another chevron or resize
  its glyph. Browser geometry assertions verify the inset; the workspace lint
  guard rejects imported chevrons inside expandable controls throughout the website, including aliases and nested labels.
  Native `<details>` uses `DisclosureSummary` to retain browser keyboard and toggle behavior.
  Coin rail names use shared Buttons with action-specific accessible labels;
  recorded buyers use overlapping avatars beside the price. Do not repeat
  Open/Show captions or a separate plus column.
- `SelectField` keeps a native select inside a shared frame: a 16px decorative
  chevron with a 12px end inset and 36px reserved text padding. Its `className`
  places the outer frame; native props, IDs, refs, names and event handlers stay
  on the select. Features must not add an arrow, reset appearance or use a raw select.
- TextArea and SelectField retain native semantics. Inputs keep precision,
  validation IDs and refs. IconButton requires an accessible name. Buttons
  default to `type="button"`; forms opt into submit explicitly. Busy buttons
  retain their label width, announce the operation and block activation.
- Native disabled is the default. `focusableDisabled` is an explicit exception
  for an unavailable action needing a keyboard-accessible explanation; it still
  blocks click, Enter and Space. Keep financial guards in the feature as well.
- Compose Base UI triggers/closes with `render={<Button ... />}` (or IconButton)
  so the library owns popup behavior while our primitive owns its presentation.
  Put labels inside the rendered control (never `children={null}` with a label
  on the outer trigger); this preserves Base UI render composition.
  Pass existing refs, handlers and ARIA through; do not replace library menus
  with hand-built focus management.
- Shared controls consume semantic `--action`, `--action-press`, `--on-action`,
  `--focus-color`, `--control-surface` and `--control-hover` tokens. The web
  defaults use Blast pink in both themes, per the user’s 2026-10-26 direction;
  Workspace panels and sheets share the same tokens. Keep primitives
  independent of feature code.

ESLint enforces this for all production TSX under `apps/web/src`.
`scripts/eslint/shared-controls-legacy.json` records remaining native-control
ceilings per file; it is a migration ledger, not permission to add alternatives.
It may only shrink. New files and the migrated workspace have zero allowance.
The React Grid Layout resize adapter is a documented native exception because
its hit geometry and ref contract belong to the library. Chart activity markers
use shared Buttons and Facepile avatars; only their chart coordinates and small
direction/type badges are feature-specific. Existing menu items keep their headless-library
semantics. New exceptions require a concrete reason and a narrow reviewed rule.

Temporary `!important` protection in the control stylesheet prevents legacy page
selectors from detaching focus or changing corners during migration. Remove
competing feature styles as each surface migrates; reduce that specificity only
after browser verification proves the same contract. Do not grow the overrides.
The test-only `/controls-proof` fixture covers the shared states outside Blast
mode; real feature flows still require route/state browser verification. The
legacy inventory is not evidence that every existing screen has been migrated.

Chart activity appears inside the price plot. Identify people with existing
avatars, group overlapping events with a count, and preserve every event in the
details popover. Distinguish confirmed buys/sells from authored calls/theses;
show actual post text and its canonical link. Trade timestamps may align with
the observed chart line but must never claim an execution price that the feed
does not provide. Keep time-only markers in chart gaps, and put coverage and
recovery notices outside marker hit targets. Qualify the trade window explicitly
so it does not imply the same coverage for posts. Omit routine success captions;
show a status only when it changes what the user can do or trust.

### Shared control material and hierarchy

The user reaffirmed the attached Slush light/dark reference and [Suilend](https://suilend.fi/)
on 2026-10-26. Translate their clear hierarchy and surface depth into Blast’s
existing pink palette and radius roles. Secondary controls use a raised neutral
surface with a restrained edge and shadow; fields use an inset tonal surface.
Ghost and unselected segment controls stay quiet. Corners follow the boards'
scale (sm 9, md and chip 10, lg 14, nested 7). Keep the fixed icon glyphs and
the protected target/inset contract.

Shared sheet headings use the body UI family at 22px/1.3 with 650 weight,
24px content-group spacing, and the shared secondary close control. Brand
display type remains for identity and prominent product figures. Use tonal
groups for quick-trade holdings and keep each holding’s amounts, PnL and actions
adjacent. Align PnL labels, amounts and percentages in consistent columns with
tabular numerals; use shared primary Buy and secondary Sell buttons. Default
field boundaries must reach 3:1 against their adjoining surfaces before focus.
Do not copy reference-specific payment interactions or replace Blast
corners with pills. Contrast, disabled/busy behavior, keyboard focus and
financial precision take precedence over surface effects. Increased contrast
strengthens control boundaries independently of reduced motion/transparency.

### Compact market workspace

Focus mode places discovery in a collapsible left rail on desktop; phones use
the shared market sheet. Expansion is a workspace preference, independent of
panel visibility. Desktop market selection keeps the rail open. Search and
filters reuse the shared market browser; do not duplicate discovery beneath
the chart. Trades, Holders and Posts belong to the selected market's lower
context. Presale allocation remains inside that presale, even when optional
context is hidden.

Discovery keeps the coin selector, contract inspection/copy and notable-holder
control in one identity group. Contract tools remain independent of selection;
they do not become an indented footer. Freshness remains available in the refresh
control; preserve delayed/error/partial-price indicators without adding
explanatory rows to the list. Dense trades keep trader, side, value and
time on one row where they fit; compact relationship badges preserve name space.
Project socials belong beside the market title, outside the trade form.

Desktop panels share one bottom-right React Grid Layout resize grip. Reveal it
on fine-pointer panel hover or keyboard focus. Stacked chart/activity panels use
a bottom grip; touch reveals resizing in Edit layout, while the trade form keeps
its natural height. Do not add resize axes to compensate for surrounding spacing.


### Trade ticket composition

Keep the position summary, amount entry and quote/action as distinct groups.
Labels use quiet 12px regular text; token balances use 13px medium, holding
value 28px semibold and unrealized PnL 20px semibold with its sign and percentage.
Currency and token symbols remain explicit. These are ticket-specific roles,
not changes to shared control typography across the site.

Let the desktop form fill its resized card. Center the amount-entry group in
available space between the side selector and quote, with the action near the
bottom content inset. Flexible margins collapse when space is tight; mobile
keeps natural height and short desktop cards scroll. Preserve quote details
before submission in both visual and keyboard order. Empty feedback must not
reserve a footer gap; actual warnings and errors retain their space.

### Missing optional metrics

Omit unavailable optional figures together with their labels, including PnL,
USD valuations, performance, ranks and market statistics. Do not replace them
with “Unavailable”, a dash, or explanatory filler. (A required value that is
missing shows the muted `—`; see acceptance rule 21.) Preserve confirmed zero,
exact-value inspection, private-value masks, loading skeletons and actionable
errors with retries. A displayed partial valuation must identify itself as a
priced subtotal and disclose excluded assets. Required transaction terms,
pricing prerequisites and risk disclosures must remain explicit.
