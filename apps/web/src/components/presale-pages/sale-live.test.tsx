import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

/**
 * P-11: the sale page's figures move after the viewer's own commit. The
 * server's read paints and hydrates with no request; the commit's
 * invalidation (`invalidateAfter`, the commit host's) reads the sale again and
 * the page shows the new raise and backers, as the gate's `paintRaise` does.
 * P-12: the presales list's rows take the same invalidation.
 */

installTestDom();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { invalidateAfter } = await import("#web/lib/query/invalidate.ts");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { useSaleDetail } = await import("./presales-client");
const { PresalesList } = await import("./PresalesList");
const { fixtureList, fixtureDetail, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");

const ID = "0xsale";
const sale = (raised: string, participants: number) =>
  ({ presale: { presale_id: ID, phase: "open", start_ms: 0, end_ms: Date.now() + 3_600_000, raised_usd: raised, participants }, raise: { points: [] }, backers: { top: [] } }) as never;

function Figures({ detail, nowMs }: Readonly<{ detail: Parameters<typeof useSaleDetail>[0]; nowMs: number }>) {
  const shown = useSaleDetail(detail, nowMs);
  return <b>{`${shown.presale.raised_usd}/${shown.presale.participants}`}</b>;
}

test("P-11: the server's sale paints with no request, and a commit's invalidation brings the new raise and backers", async () => {
  let reads = 0;
  const before = globalThis.fetch;
  let root: ReturnType<typeof createRoot> | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), `/api/social/presales/${ID}`);
    reads += 1;
    return Response.json(sale("120.00", 4));
  }) as typeof globalThis.fetch;
  try {
    const served = sale("100.00", 3);
    assert.equal(renderToString(withQueryClient(createTestQueryClient(), <Figures detail={served} nowMs={Date.now()} />)), "<b>100.00/3</b>");
    const client = createTestQueryClient();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = (root = createRoot(container));
    await act(async () => mounted.render(withQueryClient(client, <Figures detail={served} nowMs={Date.now()} />)));
    await act(async () => settleQueries(client));
    assert.equal(reads, 0, "hydration asks nothing");
    assert.equal(container.textContent, "100.00/3");
    await act(async () => invalidateAfter(client, { kind: "commit", presaleId: ID }));
    await act(async () => settleQueries(client));
    assert.equal(reads, 1);
    assert.equal(container.textContent, "120.00/4");
    client.clear();
  } finally {
    // A failed assertion must not leave a clock ticking (the run would never end).
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    globalThis.fetch = before;
  }
});

test("P-12: the presales list's rows take a commit's invalidation: the row's fill moves, no request at hydration", async (t) => {
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  const page = fixtureList("live", "ending");
  const first = page.presales[0]!;
  const moved = { ...page, presales: page.presales.map((row) => (row.presale_id === first.presale_id ? { ...row, raised_atoms: (BigInt(row.target_atoms) / 2n).toString() } : row)) };
  let reads = 0;
  const before = globalThis.fetch;
  let root: ReturnType<typeof createRoot> | undefined;
  globalThis.fetch = (async () => {
    reads += 1;
    return Response.json(moved);
  }) as typeof globalThis.fetch;
  try {
    const client = createTestQueryClient();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = (root = createRoot(container));
    await act(async () => mounted.render(withQueryClient(client, <PresalesList initial={page} layout="list" nowMs={Date.now()} sort="ending" status="live" view="list" />)));
    await act(async () => settleQueries(client));
    assert.equal(reads, 0, "the server's page seeds the read");
    const fill = () => container.querySelector(`[data-list-row="${first.presale_id}"] [role="progressbar"]`)?.getAttribute("aria-valuenow");
    assert.equal(fill(), "99.65");
    await act(async () => invalidateAfter(client, { kind: "commit", presaleId: first.presale_id }));
    await act(async () => settleQueries(client));
    assert.equal(reads, 1);
    assert.equal(fill(), "50", "the row's own figure moved (its counters tween; the fill does not)");
    client.clear();
  } finally {
    // A failed assertion must not leave a clock ticking (the run would never end).
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    globalThis.fetch = before;
  }
});

test("infra hints move a closed sale through funding and migration through the shared stream without polling", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const { LiveQueries } = await import("#web/components/social/LiveQueries.tsx");
  const { infraProvenanceFixture } = await import("../../../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts");
  const { tabActivityHints } = await import("#web/components/social/home/activity-hints.ts");
  const { saleReadEveryMs } = await import("./presales-client");
  const { queryKeys } = await import("#web/lib/query/keys.ts");
  const beforeFetch = globalThis.fetch;
  const beforeSource = globalThis.EventSource;
  const beforeNow = Date.now;
  let now = beforeNow();
  let opens = 0;
  let reads = 0;
  let phase: "closed" | "funded" | "trading" = "closed";
  const sources: FakeEventSource[] = [];
  class FakeEventSource extends EventTarget {
    readyState = 0;
    constructor(url: string) {
      super();
      assert.equal(url, "/api/social/activity/hints");
      opens += 1;
      sources.push(this);
    }
    close() {}
  }
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const base = fixtureDetail("drft");
  const served = { ...base, presale: { ...base.presale, presale_id: ID, phase: "closed" as const } };
  function Stage() {
    const detail = useSaleDetail(served, now);
    return <b>{detail.presale.phase}</b>;
  }
  const receive = (frame: unknown) => sources[0].dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  try {
    Date.now = () => now;
    Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true, writable: true });
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      assert.equal(String(url), `/api/social/presales/${ID}`);
      reads += 1;
      return Response.json({ ...served, presale: { ...served.presale, phase } });
    }) as typeof fetch;
    client.setQueryData(queryKeys.me.wallet(), { untouched: true });
    await act(async () => root.render(withQueryClient(client, <><LiveQueries /><Stage /><Stage /></>)));
    await act(async () => settleQueries(client));
    assert.equal(reads, 0, "no hydration read");
    assert.equal(opens, 1, "both columns and the global bridge share one stream");
    await act(async () => {
      receive({ type: "hello", provenance: infraProvenanceFixture({ deployment_fingerprint: null }) });
      receive({ type: "pong" });
      await settleQueries(client);
    });
    assert.equal(tabActivityHints()!.connected(), true);
    assert.equal(saleReadEveryMs(served.presale, now, true), false);
    assert.equal(reads, 1, "a connect reads what was missed");
    for (const nextPhase of ["funded", "trading"] as const) {
      phase = nextPhase;
      now += 6_000;
      await act(async () => {
        receive({ type: "presale_lifecycle", presale_id: ID, state: phase === "trading" ? "migrated" : phase });
        await settleQueries(client);
      });
      assert.equal(container.textContent, `${phase}${phase}`, "both columns show the lifecycle change");
    }
    assert.equal(reads, 3, "one read per signal, shared by both columns");
    assert.deepEqual(client.getQueryData(queryKeys.me.wallet()), { untouched: true });
    await act(async () => sources[0].dispatchEvent(new Event("error")));
    assert.equal(tabActivityHints()!.connected(), false);
    assert.equal(saleReadEveryMs(served.presale, now, false), 30_000, "disconnect restores the unfinished sale's fallback");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = beforeFetch;
    Object.defineProperty(globalThis, "EventSource", { value: beforeSource, configurable: true, writable: true });
    Date.now = beforeNow;
  }
});
