import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import type { TraderProfiles } from "@blast/core/modules/social/contracts/trader-profiles.ts";
import type { ListState } from "./activity-model";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient, settleQueries } = await import("#web/lib/query/test-client.ts");
const { useTraderProfiles, profilesPollMs } = await import("./trader-profiles.ts");
const { parseInfraProvenance } = await import("@blast/core/modules/launchpad-contract/provenance.ts");
const { classifiedActivityBody } = await import("../../../../../../packages/core/test/fixtures/modules/launchpad-coin/activity-fixtures.ts");
const { parseClassifiedActivityPage } = await import("@blast/core/modules/launchpad-contract/activity.ts");
const { COIN_FIXTURE } = await import("../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts");
const { afterRefresh, initialList, activityKey } = await import("./activity-model");
const { recentTrades } = await import("./recent-trades.ts");
const { traderProfileKey } = await import("@blast/core/modules/social/contracts/trader-profiles.ts");

test("public profile links stay visible during refresh and clear on errors, stale feeds or privacy changes", async (t) => {
  const body = classifiedActivityBody("migrated", { limit: 100 }, 1_790_235_061_630);
  const page = parseClassifiedActivityPage(COIN_FIXTURE.launchId, body);
  const activity = afterRefresh(initialList<ActivityRow>(), { kind: "rows", rows: page.activity, next: null, provenance: parseInfraProvenance(body.provenance), lagging: false }, activityKey);
  const profiles = Object.fromEntries(recentTrades(page.activity).flatMap((row) => row.actor ? [[traderProfileKey({ address: row.actor, timestampMs: row.timestampMs }), { callsign: "alice", avatarUrl: null }]] : []));
  const requests: Array<(response: Response) => void> = [];
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => requests.push(resolve)));
  const client = createTestQueryClient();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  let shown: TraderProfiles = {};
  function Probe({ launchId, state, rows, leaving }: Readonly<{
    launchId: string; state: ListState<ActivityRow>; rows?: readonly ActivityRow[]; leaving?: ActivityRow;
  }>) {
    shown = useTraderProfiles(launchId, state, true, rows, leaving);
    return null;
  }
  const show = async (launchId: string, state = activity, rows?: readonly ActivityRow[], leaving?: ActivityRow) => {
    await act(async () => root.render(withQueryClient(client, <Probe launchId={launchId} state={state} rows={rows} leaving={leaving} />)));
  };
  const answer = async (response: Response) => {
    const resolve = requests.shift(); assert.ok(resolve);
    await act(async () => { resolve(response); await settleQueries(client); });
  };
  try {
    await show("first");
    assert.deepEqual(shown, {});
    await answer(Response.json(profiles));
    assert.deepEqual(shown, profiles);
    await act(async () => { void client.refetchQueries({ queryKey: ["trader-profiles"] }); });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    assert.deepEqual(shown, profiles, "keep verified icons while refreshing");
    await answer(new Response(null, { status: 503 }));
    assert.deepEqual(shown, {});
    await show("second");
    await show("third");
    const old = requests.shift(); assert.ok(old);
    await act(async () => old(Response.json(profiles)));
    assert.deepEqual(shown, {});
    await answer(Response.json(profiles));
    assert.deepEqual(shown, profiles);
    await show("third", activity, recentTrades(page.activity).slice(1));
    assert.equal(Object.keys(shown).length, Object.keys(profiles).length - 1, "a profile outside the rendered rows is cleared");
    await show("third");
    await act(async () => { void client.refetchQueries({ queryKey: ["trader-profiles"] }); });
    await answer(Response.json(Object.fromEntries(Object.keys(profiles).map((key) => [key, null]))));
    assert.deepEqual(Object.values(shown), Object.keys(profiles).map(() => null));
    await show("third", { ...activity, latest: { kind: "failed", reason: "unreachable" } });
    assert.deepEqual(shown, {});
    await show("fourth");
    await answer(Response.json(profiles));
    const leaving = recentTrades(page.activity).at(-1);
    assert.ok(leaving?.actor);
    const leavingKey = traderProfileKey({ address: leaving.actor, timestampMs: leaving.timestampMs });
    await show("fourth", activity, [], leaving);
    assert.deepEqual(shown, { [leavingKey]: profiles[leavingKey] }, "the last confirmed avatar remains steady through its exit");
    await show("fourth", activity, []);
    assert.deepEqual(shown, {}, "no stale public links remain when all visible rows are provisional");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});

// This fails if the live screen keeps reading profiles every 15 s, or stops reading for a new trader.
test("profiles rest at 60 s while the live screen listens and every shown trader has an answer", () => {
  const alice = { address: "0x1", timestampMs: 1 };
  const bob = { address: "0x2", timestampMs: 2 };
  const answered = { [traderProfileKey(alice)]: null };
  assert.equal(profilesPollMs(true, [alice], answered), 60_000);
  assert.equal(profilesPollMs(true, [alice, bob], answered), 15_000, "a new trader is asked for on the fast pace");
  assert.equal(profilesPollMs(false, [alice], answered), 15_000);
  assert.equal(profilesPollMs(true, [alice], undefined), 15_000);
});
