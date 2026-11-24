---
name: blast-frontend-review
description: Review Blast web UI for concise dates, recognizable icons, duplicate labels, and meaningful color. Use for whole-site frontend reviews, before-and-after comparisons, or passes to make a Blast screen easier to scan.
---

# Review Blast frontend clarity

Read the [Blast UI standard](../../../.claude/skills/blast-ui/SKILL.md) for components, tokens, and the visual review protocol.

## Review in order

1. Inventory the routes, responsive variants, and states in scope. For a site-wide pass, include routes, nested panels, dialogs, lists, empty/error states, and authenticated surfaces. Trace formatter output to where it renders. Include client-only states and read-only surfaces such as legal headers. Distinguish visible copy from a hover value, a signing input, or internal data.
2. For each surface, write down the next decision and the facts needed for it. Remove repeated words and marks first. Shorten the visible value only if the exact source stays recoverable. Replace repeated secondary actions only when the icon and its placement make the action recognizable.
3. Apply the rules below across matching instances with shared components. Record choices that depend on context, including labels that remain useful. For a review-only request, return the findings with concrete locations and leave the source as-is.
4. Compare the same data, state, viewport, and theme before and after. Verify destination, accessible name, focus, and tap behavior. In a row with an event permalink and an explorer icon, follow each target separately. Exercise buy and sell, long tickers, missing values, same-day events, and narrow scrolling tables. List covered routes and state what the checks actually exercised.

## Decisions to reuse

| Surface | Display | Detail or exception |
| --- | --- | --- |
| Calendar date | `22 Nov ’26` using the shared `DateStamp`. Format in UTC so the day is stable. | Show the full date and UTC time on hover. Use keyboard and tap inspection for standalone values. For dates inside a link, keep one interactive target and attach exact time to its hover text. For a calendar day without a known clock, keep date-only semantics. |
| Intraday sequence | A compact date plus clock where it distinguishes chart points, vesting releases, or an actionable cutoff. | Check rows with the same date. If people compare their time within a day, show the clock or group by day and show clocks per row. Label date-only columns “Date”. Keep seconds where the interval needs them. Keep the exact clock and zone visible on schedule entry and signing review. Preserve relative times where the interval is the useful fact. |
| Swap amounts in Launch activity | Red **In** for the asset sent into the swap, then green **Out** for the asset received. Show the actual amounts and tickers with their coin marks. | Keep `In` and `Out` as words so color never carries direction alone. Check a buy and a sell with both assets. Use the existing up/down tokens. Keep explicit terms for refunds, bids, fees, and allocations. |
| Repeated explorer action | A shared external-link icon at the row edge. | Keep the transaction-specific accessible name, hover label, focus ring, and destination. Transaction notifications and presale contribution receipts keep a visible explorer link, such as **View transaction**, because it is a standalone follow-up. |
| Recognizable identity | Use the real Bluefin and Cetus marks and the actual coin mark. Keep the ticker next to a financial amount. | Give a mark-only venue an accessible name. Use one mark per control or amount. A nearby wallet balance can show the amount and unit in text when the asset already has a logo in the field. |
| Color | Use semantic color where it speeds up reading amounts, movements, or state. | Keep a word, sign, position, or accessible name that carries the same fact. Test both themes. Use each token for its established meaning and keep primary actions legible. |

A label earns its place when it identifies a decision, qualifies a number, tells the reader what happened, or names an action that its icon cannot carry alone.
