import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { COIN_FIXTURE } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { FIXTURE_PARTNER, launchRewardsBody } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/rewards-fixtures.ts";
import type { LaunchLifecycle } from "@blast/core/modules/launchpad-contract/discovery.ts";
import { parseInfraProvenance } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { parseLaunchRewards } from "@blast/core/modules/launchpad-contract/rewards.ts";

import { afterRead, INITIAL_FEES, type FeesState } from "./fees-model";
import { FeesView, type FeesViewProps } from "./FeesView";

const NOW = 1_790_235_061_630;
const UNITS = { symbol: "FROGGY", memeDecimals: 6, quoteSymbol: "SUI", quoteDecimals: 9 };

function fees(lifecycle: LaunchLifecycle, lagMs?: number): FeesState {
  const body = launchRewardsBody(lifecycle, NOW, lagMs);
  return afterRead(INITIAL_FEES, {
    kind: "rewards",
    rewards: parseLaunchRewards(COIN_FIXTURE.launchId, body),
    provenance: parseInfraProvenance(body.provenance),
    lagging: (lagMs ?? 0) > 30_000,
  });
}

function render(overrides: Partial<FeesViewProps> = {}) {
  const props: FeesViewProps = { launchId: COIN_FIXTURE.launchId, state: fees("live"), units: UNITS, pending: false, onRefresh: () => {}, ...overrides };
  return renderToStaticMarkup(<FeesView {...props} />);
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

/** The text of the table row whose first cell is `share`. */
function row(html: string, caption: string, share: string) {
  const table = html.slice(html.indexOf(caption));
  const start = table.indexOf(`>${share}</th>`);
  assert.ok(start >= 0, `${caption}: ${share}`);
  return text(table.slice(table.indexOf("</th>", start) + 5, table.indexOf("</tr>", start)));
}

test("before migration the curve's ledger is the launch's whole fees: each share earned, claimed and unclaimed, in its own coin", () => {
  const html = render();
  const words = text(html);
  assert.match(words, /Fees and payouts Bonding curve The creator's and Blast's share of every curve trade, and Blast's SUI creation fee/);
  assert.doesNotMatch(words, /Migration vault|until migration/);
  assert.match(words, /Share Earned Claimed Unclaimed/);
  assert.match(words, /Amounts are cut to two decimal places \(four significant digits below 1\), never rounded up\./);
  assert.equal(row(html, "Bonding curve fees", "Creator, SUI"), "0.41 SUI 0 SUI 0.41 SUI");
  assert.equal(row(html, "Bonding curve fees", "Creator, FROGGY"), "14,000 FROGGY 0 FROGGY 14,000 FROGGY");
  assert.equal(row(html, "Bonding curve fees", "Blast, SUI"), "0.205 SUI 0 SUI 0.205 SUI");
  // A SUI Quote and the SUI creation fee are two rows, each saying which it is.
  assert.equal(row(html, "Bonding curve fees", "Blast, creation fees (SUI)"), "2 SUI 0 SUI 2 SUI");
  // The creator takes no SUI, so it has no SUI row.
  assert.equal((html.match(/>Creator, /g) ?? []).length, 2);
});

test("after migration the curve stands as it closed and the vault carries on, apart, with the partner's pay and what holders got back", () => {
  const html = render({ state: fees("migrated") });
  const words = text(html);
  assert.match(words, /Bonding curve, until migration The creator's and Blast's share of every curve trade, Blast's SUI creation fee and its one-time migration fee\. The ledger closed at migration and keeps its totals/);
  // Each partner payment sits under a visible label, and Blast's claims are said to include it.
  assert.match(words, /Blast's claimed amounts include what its claims paid the launch's partner\./);
  assert.match(words, /Paid to the partner from Blast's curve fees Partner/);
  assert.match(words, /Paid to the partner from Blast's LP fees Partner/);
  assert.match(words, /Returned to holders and the coin Holder rewards set aside/);
  assert.match(words, /Migration vault, since migration/);
  assert.equal(row(html, "Migration vault fee shares", "Creator, FROGGY"), "450 FROGGY 400 FROGGY 50 FROGGY");
  assert.match(words, new RegExp(`Partner 0xbbbb…bbbb ${FIXTURE_PARTNER} Paid 700 FROGGY, 0\\.0245 SUI, 0\\.2 SUI`));
  assert.match(words, /Collected 1,000 FROGGY, 0\.5 SUI/);
  assert.match(words, /Holder rewards set aside 270 FROGGY, 0\.135 SUI/);
  assert.match(words, /Published to reward rounds 200 FROGGY, 0\.1 SUI/);
  assert.match(words, /Bought back and burned 30 FROGGY for 0\.04 SUI/);
  // The two ledgers are never added together.
  assert.doesNotMatch(words, /total fees|all-time|combined|both ledgers/i);
});

test("unknown decimals leave amounts unavailable", () => {
  const words = text(render({ units: { ...UNITS, memeDecimals: null } }));
  assert.doesNotMatch(words, /14000000000 FROGGY atoms/);
  assert.match(words, /—/);
});

test("an outage labels retained fee figures Delayed and an empty section Unavailable", () => {
  assert.match(text(render({ state: INITIAL_FEES })), /Loading Reading the launch's fees from blast-infra/);
  const failed = afterRead(fees("live"), { kind: "failed", reason: "unreachable" });
  const delayed = text(render({ state: failed }));
  assert.match(delayed, /Delayed Fees may be out of date/);
  assert.match(delayed, /14,000 FROGGY/);
  const none = afterRead(INITIAL_FEES, { kind: "failed", reason: "not_ready" });
  const words = text(render({ state: none }));
  assert.match(words, /Unavailable Fees couldn’t load/);
  assert.match(words, /Use Refresh fees to try again/);
  assert.doesNotMatch(words, /Bonding curve/);
  assert.match(text(render({ state: fees("live", 45_000) })), /Delayed Fees may be out of date/);
});

test("a refresh is a labelled pending action", () => {
  const html = render({ pending: true });
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-busy="true"/);
  assert.match(text(html), /Refreshing fees/);
});
