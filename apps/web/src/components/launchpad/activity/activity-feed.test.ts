import assert from "node:assert/strict";
import test from "node:test";

import { classifiedActivityBody } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/activity-fixtures.ts";
import { COIN_FIXTURE } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { activityAnchor, parseClassifiedActivityPage, type ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { parseInfraProvenance } from "@blast/core/modules/launchpad-contract/provenance.ts";

import { createActivityFeed, linkTarget, listStart, type ActivityFeedReads } from "./activity-feed";
import { flowDisplay, listDisplay, type FlowOutcome, type PageOutcome } from "./activity-model";
import { createTradeTape } from "./trade-tape";

const LAUNCH = COIN_FIXTURE.launchId;
const NOW = 1_790_235_061_630;

test("one list holds every record: a link to any of them, a venue swap's included, starts it at that record", () => {
  assert.equal(listStart(LAUNCH, null), null);
  for (const anchor of ["325910100:0:1:1", "326100000:2:5:0", "326274000:1:1:0"]) {
    assert.equal(listStart(LAUNCH, anchor), activityAnchor(LAUNCH, anchor).cursor, anchor);
  }
});

/** The fixture's classified page at `cursor`, as a read's outcome. */
function activityPage(cursor: string | null, lifecycle: "live" | "migrated" = "migrated"): PageOutcome<ActivityRow> {
  const body = classifiedActivityBody(lifecycle, { cursor }, NOW);
  const page = parseClassifiedActivityPage(LAUNCH, body);
  return { kind: "rows", rows: page.activity, next: page.nextCursor, provenance: parseInfraProvenance(body.provenance), lagging: false };
}

const FLOW_FAILED: FlowOutcome = { kind: "failed", reason: "not_ready" };

/** Reads that answer from the fixtures at once and record what they were asked. */
function recordingReads() {
  const asked = { activity: [] as (string | null)[], flow: 0 };
  const reads: ActivityFeedReads = {
    activity: async (cursor) => (asked.activity.push(cursor), activityPage(cursor)),
    flow: async () => (asked.flow++, FLOW_FAILED),
  };
  return { asked, reads };
}

test("the server page initializes the recent trades tape and only flow reads on mount", async () => {
  const { asked, reads } = recordingReads();
  const page = activityPage(null);
  assert.equal(page.kind, "rows");
  assert.ok(page.provenance.checkpoint);
  const checkpoint = page.provenance.checkpoint + 1;
  const initialActivity = { ...page, provenance: { ...page.provenance, checkpoint } };
  const feed = createActivityFeed({ reads, start: null, initialActivity });
  const tape = createTradeTape(feed);
  const initial = tape.serverSnapshot();
  assert.equal(initial.rows[0]?.position, "326274000:1:1:0");
  assert.equal(initial.rows.length, 4);
  assert.equal(initial.entering, null);
  assert.equal(tape.snapshot(), initial);
  assert.equal(feed.readThrough(), checkpoint);

  await Promise.all([feed.initialize(), feed.initialize()]);
  assert.deepEqual(asked, { activity: [], flow: 1 });
  await feed.refresh(false);
  assert.deepEqual(asked, { activity: [null], flow: 2 });
  assert.equal(feed.readThrough(), checkpoint, "a browser answer from behind the seed cannot rewind it");
});

test("recent trades show on the browser fallback while flow is pending", async () => {
  const flow = Promise.withResolvers<FlowOutcome>();
  const initialActivity: PageOutcome<ActivityRow> = { kind: "failed", reason: "not_ready" };
  const reads: ActivityFeedReads = {
    activity: async (cursor) => activityPage(cursor),
    flow: () => flow.promise,
  };
  const feed = createActivityFeed({ reads, start: null, initialActivity });
  const initialized = feed.initialize();
  await Promise.resolve();
  assert.equal(feed.state().activity.view?.rows[0]?.position, "326274000:1:1:0");
  assert.equal(flowDisplay(feed.state().flow).kind, "loading");
  flow.resolve(FLOW_FAILED);
  await initialized;
  assert.equal(flowDisplay(feed.state().flow).kind, "unavailable");
});

test("an older first-page read that answers after a newer one is dropped, for the list and the flow", async () => {
  const answers = { activity: [] as ((page: PageOutcome<ActivityRow>) => void)[], flow: [] as ((flow: FlowOutcome) => void)[] };
  const reads: ActivityFeedReads = {
    activity: () => new Promise((resolve) => answers.activity.push(resolve)),
    flow: () => new Promise((resolve) => answers.flow.push(resolve)),
  };
  const feed = createActivityFeed({ reads, start: null });
  const first = feed.refresh(false);
  const second = feed.refresh(false);
  const provenance = parseInfraProvenance(classifiedActivityBody("migrated", {}, NOW).provenance);
  const windows = Object.fromEntries(["5m", "1h", "6h", "24h", "all"].map((name) => [name, { netQuoteFlow: 7n, buyers: 1, sellers: 0 }])) as never;
  answers.activity[1]!(activityPage(null, "migrated"));
  answers.flow[1]!({ kind: "flow", flow: { windows }, provenance, lagging: false });
  await second;
  // The older reads fail late: the newer answers stand, current and not Stale.
  answers.activity[0]!({ kind: "failed", reason: "unreachable" });
  answers.flow[0]!({ kind: "failed", reason: "unreachable" });
  await first;
  const state = feed.state();
  assert.equal(state.activity.view?.rows[0]?.position, "326274000:1:1:0", "the newest venue swap heads a migrated launch's list");
  assert.deepEqual(listDisplay(state.activity), { kind: "rows", view: state.activity.view, stale: null });
  assert.deepEqual(flowDisplay(state.flow), { kind: "flow", view: state.flow.view, stale: null });
});

test("every refresh of an anchored feed starts the list at the link; older pages follow their own cursor", async () => {
  const { asked, reads } = recordingReads();
  const start = listStart(LAUNCH, "326274000:1:1:0");
  const feed = createActivityFeed({ reads, start });
  assert.equal(feed.start, start, "the feed keeps the start it reads from, for the view and the scroll");
  const changes: number[] = [];
  feed.subscribe(() => changes.push(changes.length));
  // A manual refresh, then two polls.
  await feed.refresh(true);
  await feed.refresh(false);
  await feed.refresh(false);
  assert.deepEqual(asked.activity, [start, start, start]);
  assert.ok(changes.length > 0);
  assert.equal(feed.state().pending, null);
  const next = feed.state().activity.view!.next!;
  await feed.more();
  assert.equal(asked.activity.at(-1), next);
});

test("a hinted refresh reads the first page and the flow at the hint's checkpoint; pages back never name one", async () => {
  const asked: { list: string; at: number | null }[] = [];
  const pinnedFlow = Promise.withResolvers<FlowOutcome>();
  const reads: ActivityFeedReads = {
    activity: async (cursor, at) => (asked.push({ list: "activity", at }), activityPage(cursor)),
    flow: async (at) => (asked.push({ list: "flow", at }), at === null ? FLOW_FAILED : pinnedFlow.promise),
  };
  const feed = createActivityFeed({ reads, start: null });
  await feed.refresh(false, 326274009);
  assert.equal(listDisplay(feed.state().activity).kind, "rows");
  assert.equal(flowDisplay(feed.state().flow).kind, "loading");
  pinnedFlow.resolve(FLOW_FAILED);
  await feed.refresh(false);
  await feed.more();
  assert.deepEqual(asked, [
    { list: "activity", at: 326274009 },
    { list: "flow", at: 326274009 },
    { list: "activity", at: null },
    { list: "flow", at: null },
    { list: "activity", at: null },
  ]);
});

test("a durable link scrolls to its record once the list answers, else to the note that says it is not there", async () => {
  const opened = async (anchor: string) => {
    const { reads } = recordingReads();
    const feed = createActivityFeed({ reads, start: listStart(LAUNCH, anchor) });
    const before = linkTarget(LAUNCH, anchor, feed.state());
    await feed.refresh(false);
    return { before, after: linkTarget(LAUNCH, anchor, feed.state()) };
  };
  assert.deepEqual(await opened("325910100:0:1:1"), { before: null, after: "activity-325910100:0:1:1" });
  assert.deepEqual(await opened("326274000:1:1:0"), { before: null, after: "activity-326274000:1:1:0" });
  assert.equal((await opened("325910150:0:0:0")).after, `${LAUNCH}-activity-link`);
  assert.equal((await opened("1:0:0:0")).after, `${LAUNCH}-activity-link`);
  assert.equal((await opened("326274000:1:1:1")).after, `${LAUNCH}-activity-link`);
  const { reads } = recordingReads();
  assert.equal(linkTarget(LAUNCH, null, createActivityFeed({ reads, start: null }).state()), null);
});

test("a newer first page offered beside several loaded pages replaces them only when asked", async () => {
  let newest: PageOutcome<ActivityRow> = activityPage(null, "live");
  const reads: ActivityFeedReads = {
    activity: async (cursor) => (cursor === null ? newest : activityPage(cursor, "live")),
    flow: async () => FLOW_FAILED,
  };
  const feed = createActivityFeed({ reads, start: null });
  await feed.refresh(false);
  await feed.more();
  const loaded = feed.state().activity.view!;
  // More rows arrived than a page holds: the refresh cannot reach the loaded rows.
  newest = {
    kind: "rows",
    rows: [{ ...loaded.rows[0]!, position: "326200000:0:0:0", checkpoint: 326_200_000 }],
    next: "more",
    provenance: loaded.provenance,
    lagging: false,
  };
  await feed.refresh(false);
  assert.equal(feed.state().activity.view, loaded);
  assert.ok(feed.state().activity.newer);
  feed.showNewer();
  assert.deepEqual(feed.state().activity.view?.rows.map((row) => row.position), ["326200000:0:0:0"]);
});
