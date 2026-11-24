import assert from "node:assert/strict";
import test from "node:test";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { publishChartRound } = await import("../chart/chart-live-round");
const { OpeningRoundUnavailable } = await import("./OpeningRoundFacts");
const { liveBidderCount } = await import("./opening-round-facts-model");

const POOL = `blast_curve:0x${"a1".repeat(32)}`;
const DEPLOYMENT = "ab".repeat(32);
const expected = { network: "mainnet" as const, deployment: DEPLOYMENT };
const round = { startsAtMs: 1_790_200_000_000, endsAtMs: 1_790_203_600_000, totalQuote: 1n, quoteType: "0x2::sui::SUI", readAtMs: 1_790_200_600_000 };
const provenance = (checkpoint: number, lagMs = 20, deployment = DEPLOYMENT): Provenance => ({ source: "blast-infra", network: "mainnet", deployment, checkpoint, timestampMs: 1, observedAt: 1, lagMs });
const pushed = (checkpoint: number, bidderCount: number, lagMs = 20, deployment = DEPLOYMENT) => ({
  poolKey: POOL,
  provenance: provenance(checkpoint, lagMs, deployment),
  openingRound: { durationMs: 1n, startsAtMs: 1n, endsAtMs: 2n, totalCommittedQuote: 1n, bidderCount, settlement: null, deliveredCount: 0, undeliveredCount: bidderCount, state: "open" as const },
});
const bidders = (checkpoint: number | null = 10) => ({ count: 2, stale: false, live: { poolKey: POOL, expected, checkpoint } });

test("a pushed round replaces the indexed count only from a later checkpoint", () => {
  assert.deepEqual(liveBidderCount(bidders(), null), bidders());
  assert.deepEqual(liveBidderCount(bidders(), pushed(10, 9)), bidders(), "the page's own checkpoint stays authoritative");
  assert.deepEqual(liveBidderCount(bidders(), pushed(11, 3)), { count: 3, stale: false });
  assert.deepEqual(liveBidderCount(bidders(), pushed(11, 3, 600_000)), { count: 3, stale: true });
  assert.deepEqual(liveBidderCount(bidders(), { ...pushed(11, 3), poolKey: `blast_curve:0x${"b2".repeat(32)}` }), bidders(), "another pool's round");
  assert.deepEqual(liveBidderCount({ ...bidders(), live: null }, pushed(11, 3)), { ...bidders(), live: null });
});

test("the coin page's bidder count follows the chart stream's newer rounds and ignores older or foreign ones", async () => {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const text = () => container.textContent ?? "";
  try {
    await act(async () => root.render(<OpeningRoundUnavailable round={round} bidders={bidders()} reason="x" />));
    assert.match(text(), /Bidders2 \(indexed\)/);
    await act(async () => publishChartRound(pushed(12, 5)));
    assert.match(text(), /Bidders5 \(indexed\)/);
    await act(async () => publishChartRound(pushed(11, 4)));
    assert.match(text(), /Bidders5 \(indexed\)/, "an older round never replaces a newer one");
    await act(async () => publishChartRound(pushed(13, 7, 20, "cd".repeat(32))));
    assert.match(text(), /Bidders5 \(indexed\)/, "a foreign deployment's round is ignored");
    // A refreshed page at a later checkpoint is authoritative again.
    await act(async () => root.render(<OpeningRoundUnavailable round={round} bidders={{ ...bidders(14), count: 6 }} reason="x" />));
    assert.match(text(), /Bidders6 \(indexed\)/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
