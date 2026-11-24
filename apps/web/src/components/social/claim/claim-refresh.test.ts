import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, type InvalidateQueryFilters } from "@tanstack/react-query";
import { queryKeys as keys } from "#web/lib/query/keys.ts";
import { createClaimRunner } from "./claim-runner";
import { watchClaimReads } from "./claim-refresh";
import type { ClaimTarget } from "./claims";

const target: ClaimTarget = { key: "tokens:sale", presaleId: "sale", kind: "claim_tokens", done: { title: "Claimed", sub: "Sale" } };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("private rereads are bounded, ignore public evidence, and preserve confirmation on network failures", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const refreshed: (readonly unknown[])[] = [];
  const invalidate = t.mock.method(client, "invalidateQueries", async ({ queryKey }: InvalidateQueryFilters) => { refreshed.push(queryKey ?? []); throw new Error("offline"); });
  const runner = createClaimRunner(async () => ({ status: "confirmed", digest: "digest" }));
  const stop = watchClaimReads(runner, client);
  try {
    runner.run(target);
    await tick();
    client.setQueryData(["blast", "public", "sale"], { positions: [{ presale_id: "sale", status: "delivered" }] });
    assert.equal(runner.pending().size, 1);
    t.mock.timers.tick(18_000); await tick();
    assert.equal(invalidate.mock.calls.length, 9, "one fallback refresh of the claim read families");
    assert.equal(refreshed.some((key) => key.join(":") === "blast:me:wallet"), true);
    t.mock.timers.tick(120_000);
    await tick();
    assert.equal(invalidate.mock.calls.length, 9, "the fallback does not restart on cache updates");
    assert.equal(runner.view(target.key).state, "done");
    client.setQueryData(keys.me.portfolio(), { positions: [{ presale_id: "sale", status: "delivered" }] });
    assert.equal(runner.pending().size, 0);
    assert.equal(runner.view(target.key).state, "done", "late stale reads remain guarded");
  } finally { stop(); client.clear(); }
});

test("private inclusion cancels the fallback, with exact vesting totals and a fresh budget for the next digest", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const invalidate = t.mock.method(client, "invalidateQueries", async () => undefined);
  let calls = 0;
  const runner = createClaimRunner(async () => ({ status: "confirmed", digest: `digest-${++calls}` }));
  const stop = watchClaimReads(runner, client);
  const vesting: ClaimTarget = { ...target, key: "vesting:schedule", kind: "claim_vesting", scheduleId: "schedule", vesting: { claimed: "2.000000001", claimable: "0.999999999" } };
  try {
    runner.run(vesting);
    await tick();
    client.setQueryData(keys.me.presales(), { vestings: [{ schedule_id: "schedule", claimed: "2.999999999" }] });
    assert.equal(runner.pending().size, 1);
    client.setQueryData(keys.me.presales(), { vestings: [{ schedule_id: "schedule", claimed: "3" }] });
    assert.equal(runner.pending().size, 0);
    t.mock.timers.tick(30_000);
    assert.equal(invalidate.mock.calls.length, 0);
    runner.run({ ...vesting, vesting: { claimed: "3", claimable: "0.1" } });
    await tick();
    t.mock.timers.tick(18_000);
    await tick();
    assert.equal(invalidate.mock.calls.length, 9);
    stop();
    t.mock.timers.tick(30_000);
    assert.equal(invalidate.mock.calls.length, 9, "unmount cancels task-owned timers");
  } finally { stop(); client.clear(); }
});

test("private viewer reads acknowledge refunds and private holdings acknowledge tokens", async () => {
  for (const kind of ["claim_refund", "claim_tokens"] as const) {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const runner = createClaimRunner(async () => ({ status: "confirmed", digest: "digest" }));
    const stop = watchClaimReads(runner, client);
    try {
      runner.run({ ...target, kind });
      await tick();
      if (kind === "claim_refund") client.setQueryData(keys.me.presaleViewer(["sale"]), { presales: { sale: { mine: { claimed: true } } } });
      else client.setQueryData(keys.me.presales(true), { positions: [{ presale: { presale_id: "sale" }, status: "delivered" }] });
      assert.equal(runner.pending().size, 0);
    } finally { stop(); client.clear(); }
  }
});
