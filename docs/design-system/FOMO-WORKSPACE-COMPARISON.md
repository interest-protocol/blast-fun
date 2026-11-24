# Workspace comparison: Fomo PONS and Uniswap

2026-10-26. Scope: the selected coin workspace, using the user-supplied Fomo
PONS screenshot and the existing Blast trading/data capabilities.

## Evidence

- User reference: `Screenshot 2026-10-26 at 03.37.42.png`, supplied in this chat.
  It shows PONS identity and social links beside distinct market metrics, a
  prominent chart, a compact right-side trade ticket, and an About panel below.
- Blast before: `outputs/verification/2026-10-26-discovery-buyers/desktop-dark.png`
  in the parent workspace. Holdings precede Buy/Sell, the identity/metric strip
  has uneven allocation, and the chart details action is an anonymous chevron.
- First-party Uniswap source reviewed:
  [StatsSection](https://github.com/Uniswap/interface/blob/main/apps/web/src/pages/TokenDetails/components/info/StatsSection.tsx)
  allocates equal stat widths, changes column allocation on smaller screens,
  separates muted labels from prominent values, and matches loading placeholders
  to final geometry.
  [TokenDetailsHeader](https://github.com/Uniswap/interface/blob/main/apps/web/src/pages/TokenDetails/components/header/TokenDetailsHeader.tsx)
  separates identity, address copying, network selection and header actions.
  [Explore documentation](https://support.uniswap.org/hc/en-us/articles/9818094509453-How-to-use-the-Uniswap-Explore-page)
  explicitly distinguishes price, change, FDV and volume, and supports searches
  by name, address or symbol. These are inspected source/design patterns, not a
  claim that every current Uniswap screen was interactively tested.

## Decisions

| Before | Implemented direction | Why |
| --- | --- | --- |
| Price/change and three facts have uneven visual allocation | Dominant price plus equal tonal cells for 24h change, pool volume, FDV and holders | Makes labels and values easy to compare while preserving the meaning of each field |
| Wide identity allocation competes with metrics | Compact ticker/name/social/address cluster; stronger ticker | Keeps asset verification adjacent without consuming chart capacity |
| Chart details is an anonymous chevron; time window is quiet text | Existing details opens from an information icon; 24H/All uses shared segmented controls | Communicates real supported actions and a visible selected period |
| Private holdings precede the trade decision | Buy/Sell and settings lead a compact ticket; holdings remain in Portfolio | Prioritizes entering and reviewing a trade |
| Coin facts only occupy a lower context view | Compact About card below the ticket; full information retained in the lower view | Adds useful context without repeating all metadata beside the chart |
| Discovery and market rows compete for attention | Denser discovery composition and clear right-aligned values | Supports scanning while the selected asset remains primary |

The existing search, Portfolio and profile composition already has useful
behavior. No fictitious cash balance or deposit capability is added to imitate
the reference. Shared Blast controls own focus, disabled/busy states and touch
geometry. Pink remains the product accent; financial direction retains its
semantic colors and textual signs.

## Chart and data limits

This is not a one-to-one reproduction of Fomo's chart. Its screenshot includes
candles, volume, market-cap mode, indicators and drawing/chart tooling. Blast's
existing main chart remains a close-price line. Native OHLC is available only
in the Chart details SVG; it is not the main chart renderer. Both remain tied
to the available reads. External observation data does not become OHLC merely because
the reference uses candles. No invented candles, liquidity, market cap, coin age,
volume histogram, interval or indicator controls are introduced.

FDV stays labelled FDV. Pool volume remains explicitly scoped to the indexed
Blast pool over 24 hours, excluding other venues and presale commitments. Its
inspection retains exact amounts and coverage. Holder observations retain their
timestamps. Unknown values remain unavailable rather than zero.

People annotations retain their existing real trades/posts, membership filters,
read failures and coverage caveats. The reference's dense avatar history is not
permission to fabricate events or imply complete market coverage.

## Verification status

Independent cross-review inspected the combined desktop dark, mobile trade dark,
trade-settings and chart-people captures, followed by final desktop dark, final
mobile dark, and focused chart-info captures in both themes. Evidence is in
`outputs/verification/2026-10-26-fomo-hierarchy/` in the parent workspace.

| Before | After | Why |
| --- | --- | --- |
| Chart-info focus outline clipped at the right edge | Final light/dark focus captures show its complete outline | Toolbar reserves space without altering shared focus styling |
| Holdings displaced the trade entry | Final desktop/mobile captures show side, amount, presets, quote and action in order | The trade decision is immediate and readable |
| About content risked clipping in the fixed desktop stack | Compact activity summary fits beneath the ticket; full metadata remains below | Secondary information stays available without displacing the main action |
| Uneven market metrics | Final captures show a dominant price and aligned labelled facts | Denser hierarchy preserves the actual scope and meaning of values |

No material issue remains in these inspected captures or the independent trade
settings/shared-control source review. Mobile captures include a scrolled
workspace; content outside that viewport is not evidence of inaccessible data.

Parent-task verification reports seven browser groups passing with no console
errors, both themes at 320/407/768/1054/1414px including long values, passing
typecheck/lint and 19 focused tests, and React Doctor 100. Parent measurements
report a complete chart-info focus outline with 3px right/5px top clearance,
and Buy text contrast of 9.98:1 dark and 5.06:1 light. These measurements and
checks were performed by the parent task; the independent reviewer inspected
the listed captures and source rather than rerunning its browser session.

Accepted for this bounded workspace slice. This is not an all-UI pass, a live
transaction test, a deployment claim, or parity with Fomo’s chart capabilities.
