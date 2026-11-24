import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";
import { createTestQueryClient, settleQueries, withQueryClient } from "#web/lib/query/test-client.ts";
import { ServiceStatus, impactLine } from "./ServiceStatus";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

// Use the same query in both responsive instances, as the real shell does.
test("More entries share a probe with warnings that appear only for a confirmed disruption", async (t) => {
  const client = createTestQueryClient();
  let mode = "healthy";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    assert.equal(input, "/api/social/health");
    calls += 1;
    if (mode === "error") return new Response("unavailable", { status: 503 });
    if (mode === "malformed") return Response.json({});
    return Response.json({
      checkedAt: Date.now(), backend: "healthy",
      sui: { status: mode === "stalled" ? "stale" : "healthy", checkpoint: "9007199254740993", timestampMs: Date.now() },
    });
  });
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  await act(async () => root.render(withQueryClient(client, <><ServiceStatus /><ServiceStatus mobile /><ServiceStatus navigation /><ServiceStatus navigation /></>)));
  await act(async () => settleQueries(client));
  assert.equal(calls, 1);
  assert.equal(container.querySelectorAll('[data-tone="healthy"]').length, 2);
  assert.equal(container.querySelectorAll('[title="Service status"]').length, 2);
  assert.equal(container.querySelectorAll('[title="Services online"]').length, 0);

  for (mode of ["stalled", "error", "malformed", "healthy"]) {
    await act(async () => { await client.refetchQueries({ queryKey: ["service-health"] }); await settleQueries(client); });
    const healthy = mode === "healthy";
    assert.equal(container.querySelectorAll('[data-tone="healthy"]').length, healthy ? 2 : 0);
    const expected = healthy ? "Services online" : mode === "stalled" ? "Service disruption" : "Status unavailable";
    assert.equal(container.querySelectorAll(`[aria-label="Service status: ${expected}"]`).length, mode === "stalled" ? 4 : 2);
    assert.equal(container.querySelectorAll('[title="Service disruption"]').length, mode === "stalled" ? 2 : 0);
  }
});

test("a disruption says what the user will notice, not a raw state", () => {
  assert.equal(impactLine("healthy", "healthy"), null);
  assert.equal(impactLine("degraded", "healthy"), "Coin lists may be late or empty. Your balances are safe.");
  assert.equal(impactLine("healthy", "stale"), "Trades and balances may update slowly.");
  assert.equal(impactLine("degraded", "stale"), "Coin lists may be late or empty, and trades may confirm slowly.");
});
