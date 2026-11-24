import assert from "node:assert/strict";
import test from "node:test";

import { classifiedActivityBody } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/activity-fixtures.ts";
import { COIN_FIXTURE } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { parseClassifiedActivityPage, type ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { parseInfraProvenance } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { LaunchLifecycle } from "@blast/core/modules/launchpad-contract/discovery.ts";

import {
  afterFlow,
  afterMore,
  afterRefresh,
  initialList,
  listDisplay,
  showNewer,
  activityKey,
  flowDisplay,
  INITIAL_FLOW,
  type ListState,
  type PageOutcome,
} from "./activity-model";

const NOW = 1_790_235_061_630;

function activityPage(lifecycle: LaunchLifecycle, cursor: string | null = null, lagMs?: number): PageOutcome<ActivityRow> {
  const body = classifiedActivityBody(lifecycle, { cursor }, NOW, lagMs);
  const page = parseClassifiedActivityPage(COIN_FIXTURE.launchId, body);
  return {
    kind: "rows",
    rows: page.activity,
    next: page.nextCursor,
    provenance: parseInfraProvenance(body.provenance),
    lagging: lagMs !== undefined && lagMs > 30_000,
  };
}

const positions = (state: ListState<ActivityRow>) => state.view?.rows.map((row) => row.position) ?? [];

test("pages join across an equal-time group without repeating or skipping a row", () => {
  const first = afterRefresh(initialList<ActivityRow>(), activityPage("live"), activityKey);
  assert.equal(first.view?.rows.length, 25);
  const cursor = first.view!.next!;
  const second = afterMore(first, cursor, activityPage("live", cursor), activityKey);
  const third = afterMore(second, second.view!.next!, activityPage("live", second.view!.next!), activityKey);
  const all = positions(third);
  // The equal-time checkpoint's four trades straddle the first page's end, in transaction order.
  assert.deepEqual(all.filter((position) => position.startsWith("325990000:")), [
    "325990000:3:0:0",
    "325990000:2:0:0",
    "325990000:1:0:0",
    "325990000:0:0:0",
  ]);
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.length, 52);
  assert.equal(third.view?.next, null);
  // An answer for a cursor the list no longer ends at is dropped.
  assert.equal(afterMore(third, cursor, activityPage("live", cursor), activityKey), third);
});

test("a refresh that overlaps the loaded rows adds the newer ones and keeps the pages", () => {
  const live = afterRefresh(initialList<ActivityRow>(), activityPage("live"), activityKey);
  const two = afterMore(live, live.view!.next!, activityPage("live", live.view!.next!), activityKey);
  const refreshed = afterRefresh(two, activityPage("migration_ready"), activityKey);
  assert.deepEqual(positions(refreshed).slice(0, 3), ["326050000:0:0:1", "326050000:0:0:0", "326019800:0:0:0"]);
  assert.equal(refreshed.view?.rows.length, 52);
  assert.equal(refreshed.view?.next, two.view?.next);
  assert.equal(refreshed.newer, null);
});

test("a refresh that cannot reach the loaded rows is offered, never spliced over a gap", () => {
  const live = afterRefresh(initialList<ActivityRow>(), activityPage("live"), activityKey);
  const two = afterMore(live, live.view!.next!, activityPage("live", live.view!.next!), activityKey);
  const gap: PageOutcome<ActivityRow> = {
    kind: "rows",
    rows: [{ ...two.view!.rows[0]!, position: "326200000:0:0:0", checkpoint: 326_200_000 }],
    next: "more",
    provenance: two.view!.provenance,
    lagging: false,
  };
  const offered = afterRefresh(two, gap, activityKey);
  assert.deepEqual(positions(offered), positions(two));
  assert.deepEqual(offered.newer?.rows.map((row) => row.position), ["326200000:0:0:0"]);
  assert.deepEqual(positions(showNewer(offered)), ["326200000:0:0:0"]);
  // With one page shown, the newest page simply replaces it.
  assert.deepEqual(positions(afterRefresh(live, gap, activityKey)), ["326200000:0:0:0"]);
});

test("a failed or lagging read keeps the last rows Stale with their provenance; without rows it is Unavailable", () => {
  assert.deepEqual(listDisplay(initialList()), { kind: "loading" });
  assert.deepEqual(listDisplay(afterRefresh(initialList<ActivityRow>(), { kind: "failed", reason: "not_ready" }, activityKey)), {
    kind: "unavailable",
    reason: "not_ready",
  });
  const live = afterRefresh(initialList<ActivityRow>(), activityPage("live"), activityKey);
  const failed = afterRefresh(live, { kind: "failed", reason: "unreachable" }, activityKey);
  const shown = listDisplay(failed);
  assert.equal(shown.kind, "rows");
  if (shown.kind !== "rows") return;
  assert.deepEqual(shown.stale, { cause: "failed", reason: "unreachable" });
  assert.equal(shown.view.rows, live.view!.rows);
  assert.equal(shown.view.provenance, live.view!.provenance);
  const lagging = listDisplay(afterRefresh(live, activityPage("live", null, 45_000), activityKey));
  assert.deepEqual(lagging.kind === "rows" && lagging.stale, { cause: "lagging" });
  const recovered = listDisplay(afterRefresh(failed, activityPage("live"), activityKey));
  assert.equal(recovered.kind === "rows" && recovered.stale, null);
  // A failed "more" keeps the rows and says why.
  const more = afterMore(live, live.view!.next!, { kind: "failed", reason: "unreachable" }, activityKey);
  assert.equal(more.moreFailed, "unreachable");
  assert.equal(more.view, live.view);
});

test("the windowed flow is blast-infra's as read, kept Stale with its provenance through a failure", () => {
  const provenance = parseInfraProvenance(classifiedActivityBody("live", {}, NOW).provenance);
  const windows = Object.fromEntries(
    ["5m", "1h", "6h", "24h", "all"].map((name) => [name, { netQuoteFlow: -5n, buyers: 1, sellers: 2 }]),
  ) as never;
  assert.deepEqual(flowDisplay(INITIAL_FLOW), { kind: "loading" });
  assert.deepEqual(flowDisplay(afterFlow(INITIAL_FLOW, { kind: "failed", reason: "not_ready" })), { kind: "unavailable", reason: "not_ready" });
  const read = afterFlow(INITIAL_FLOW, { kind: "flow", flow: { windows }, provenance, lagging: false });
  assert.deepEqual(flowDisplay(read), { kind: "flow", view: { flow: { windows }, provenance }, stale: null });
  const failed = flowDisplay(afterFlow(read, { kind: "failed", reason: "unreachable" }));
  assert.deepEqual(failed, { kind: "flow", view: { flow: { windows }, provenance }, stale: { cause: "failed", reason: "unreachable" } });
  const lagging = flowDisplay(afterFlow(read, { kind: "flow", flow: { windows }, provenance, lagging: true }));
  assert.deepEqual(lagging.kind === "flow" && lagging.stale, { cause: "lagging" });
});
