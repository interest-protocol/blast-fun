import assert from "node:assert/strict";
import test from "node:test";

import type { HomeThreadPage } from "@blast/core/web/contracts/home.ts";
import { socialHomeActivityPath } from "@blast/core/web/contracts/home.ts";
import { CREATE_SUI_QUOTE_TYPE } from "@blast/core/web/contracts/create.ts";
import { installTestDom, recordAnimations, testEvent } from "../../../test/fixtures/social/test-dom.ts";
import { fixtureDetail, FIXTURE_NOW } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { infraProvenanceFixture } from "../../../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { SaleView } = await import("./SaleView");

const ID = "0xeb9dce118d582bb2ed3e5cb7da316ed0afc6365a5eeb0e20184fb32d3f533944";
const address = "0x" + "1".repeat(64);
const digest = "B".repeat(44);
const activityPath = socialHomeActivityPath(ID, "24h", null, undefined, true);

function tradePage(checkpoint: number): HomeThreadPage {
  const at = FIXTURE_NOW + (checkpoint - 100) * 1_000;
  const kind = checkpoint === 102 || checkpoint === 104 ? "trade_sell" : "trade_buy";
  const short = checkpoint === 100 ? "0x1111…1111" : "0x2222…2222";
  return {
    presale_id: ID,
    coin_type: null,
    participants: [{
      key: `w:${address}`,
      actor: { type: "address", address, short },
      followers: null,
      buys: null,
      sells: null,
      commits: null,
      claims: null,
      latest_ms: at,
      latest_kind: kind,
      events_total: 1,
      events: [{
        activity_id: `${checkpoint}:0:4294967295:0`,
        entry_id: `a:${checkpoint}:0:4294967295:0`,
        kind,
        occurred_at_ms: at,
        digest: checkpoint > 100 ? digest : null,
        quote: checkpoint > 100 ? {
          quote_type: "0x2::sui::SUI", quote_symbol: "SUI", quote_decimals: 9,
          atoms: "1234567890", usd: checkpoint === 101 ? "1000.00" : checkpoint === 105 ? "0.999" : "2.00", usd_complete: true,
        } : null,
        tokens: "1000000000",
        refund: null,
        has_why: false,
      }],
    }],
    totals: {
      scope: "pool", window: "24h", from_ms: at - 86_400_000, to_ms: at,
      participants: 1, events: 1, buyers: Number(kind === "trade_buy"), sellers: Number(kind === "trade_sell"), backers: 0, claimers: 0,
      bought: [], sold: [], committed: [], latest_ms: at,
    },
    next_cursor: null,
    window: "24h",
    clock_ms: FIXTURE_NOW + 2_000,
    as_of: { checkpoint, timestamp_ms: at, lag_ms: 0 },
  };
}

test("confirmed presale trades update the list and headline without a read, including with Holders selected", { timeout: 8_000 }, async (t) => {
  t.mock.method(Math, "random", () => 0);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(performance, "now", () => now);
  const streams: EventStream[] = [];
  let reconnected: ((source: EventStream) => void) | undefined;
  class EventStream {
    private readonly listeners = new Map<string, (event: { data: string }) => void>();
    constructor(readonly url: string) {
      streams.push(this);
      if (url.includes("presale=")) reconnected?.(this);
    }
    close() {}
    addEventListener(type: string, receive: (event: { data: string }) => void) {
      this.listeners.set(type, receive);
    }
    receive(frame: unknown, type = "hint") {
      this.listeners.get(type)?.({ data: JSON.stringify(frame) });
    }
  }

  const beforeSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: EventStream });
  const animations = recordAnimations();
  let latestCheckpoint = 100;
  let pollCanSeeLatest = false;
  const reads: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/launchpad/market/ticket") return new Response(null, { status: 204 });
    if (!path.startsWith(activityPath)) return new Response(null, { status: 404 });
    reads.push(path);
    const target = Number(path.match(/&at=(\d+)$/)?.[1] ?? 100);
    return Response.json(tradePage(pollCanSeeLatest ? latestCheckpoint : Math.min(target, latestCheckpoint)));
  });

  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function settle() { return act(async () => settleQueries(client)); }

  try {
    const fixture = fixtureDetail("kstl");
    const detail = { ...fixture, presale: { ...fixture.presale, presale_id: ID, phase: "trading" as const } };
    await act(async () => root.render(withQueryClient(client, <SaleView detail={detail} viewerEntry={null} nowMs={FIXTURE_NOW} />)));
    await settle();
    const source = streams[0];
    assert.equal(streams.length, 1);
    assert.equal(new URL(source!.url, "https://blast.test").searchParams.get("presale"), ID);
    const emitTrade = (checkpoint: number, presaleId = ID, quoteType = CREATE_SUI_QUOTE_TYPE, stream = source) => {
      const row = tradePage(checkpoint).participants[0]!.events![0]!;
      return act(async () => stream?.receive({
        type: "presale_trade", presale_id: presaleId, cursor: row.activity_id, kind: row.kind,
        timestamp_ms: row.occurred_at_ms, actor: "0x" + "2".repeat(64), digest,
        coin_atoms: row.tokens, quote_atoms: row.quote!.atoms, quote_type: quoteType, usd: row.quote!.usd,
      }, "presale"));
    };
    const panel = () => container.querySelector('[role="tabpanel"]')?.textContent;
    const chart = container.querySelector('[aria-label="Price chart"]');
    assert.ok(chart);
    const headline = container.querySelector('[data-chart-last-trade="headline"]');
    assert.ok(headline);
    const status = () => headline.querySelector('[role="status"]')?.textContent;
    assert.equal(status(), "", "history never announces a trade");
    assert.equal(chart.querySelector("[data-chart-last-trade]"), null);
    assert.equal(container.querySelector('[data-sale-market] button[aria-label="Sound"]')?.getAttribute("aria-pressed"), "false");
    const chartCues = () => animations.all.filter(({ target, timing }) =>
      target.closest("[data-chart-last-trade]") && timing.duration === 1_280);
    assert.equal(chartCues().length, 0, "history cannot flash");
    assert.match(panel() ?? "", /0x1111…1111/);
    await act(async () => {
      source?.receive({ type: "hello", provenance: infraProvenanceFixture({ deployment_fingerprint: null }) });
      source?.receive({ type: "pong", presale_checkpoint: 100 });
    });
    await settle();
    const readsAfterConnect = reads.length;
    now += 6_000;
    await emitTrade(101, address);
    await settle();
    assert.match(panel() ?? "", /0x1111…1111/, "the stream rejects another presale");
    now += 6_000;
    await emitTrade(101);
    await act(async () => {
      source?.receive({ type: "activity", activity_id: "101:0:4294967295:0", kind: "trade_buy", presale_id: ID });
    });
    await settle();
    assert.match(panel() ?? "", /0x2222…2222/, "the new buy appears without remounting the page");
    assert.equal(headline.querySelector('[data-trade-cue="buy"]')?.textContent, "Large buy · 1.23\u00a0SUI");
    assert.equal(status(), "New large buy");
    assert.equal(chartCues().length, 1);
    assert.ok(animations.all.some(({ target, timing }) =>
      target.matches('ol[aria-label="Recent trades"]') && timing.duration === 280), "the new row slides into the tape");
    animations.finishAll();
    const newestRow = container.querySelector('ol[aria-label="Recent trades"] > li');
    assert.ok(newestRow?.querySelector('[aria-label*="1.23456789 SUI"]'), "the exact fill retains the quote’s decimals");
    assert.equal(newestRow?.querySelector('a[aria-label="View transaction"]')?.getAttribute("href"), `https://suiscan.xyz/mainnet/tx/${digest}`);
    assert.equal(reads.length, readsAfterConnect, "the wallet trade and its matching hint require no new read");

    now += 6_000;
    await emitTrade(101);
    assert.equal(chartCues().length, 1, "a duplicate cannot replay the cue");

    const holders = container.querySelector<HTMLButtonElement>('[role="tab"][id$="-holders"]');
    assert.ok(holders);
    await act(async () => holders.dispatchEvent(testEvent("click")));
    await settle();
    assert.equal(holders.getAttribute("aria-selected"), "true");
    const readsAfterLeaving = reads.length;
    now += 6_000;
    await emitTrade(102, ID, `0x${"4".repeat(64)}::other::OTHER`);
    await settle();
    assert.equal(reads.length, readsAfterLeaving, "Holders keeps the live cue without another read");
    assert.equal(headline.querySelector('[data-trade-cue="sell"]')?.textContent, "Sell", "an unknown quote only shows the direction");
    assert.equal(status(), "New sell");
    assert.equal(chartCues().length, 2);
    const trades = container.querySelector<HTMLButtonElement>('[role="tab"][id$="-trades"]');
    assert.ok(trades);
    await act(async () => trades.dispatchEvent(testEvent("click")));
    await settle();
    assert.equal(container.querySelector('ol[aria-label="Recent trades"] > li [data-side]')?.getAttribute("data-side"), "sell");
    assert.equal(chartCues().length, 2, "opening Trades cannot replay the sell cue");

    now += 6_000;
    latestCheckpoint = 103;
    await act(async () => {
      source?.receive({ type: "activity", activity_id: "103:0:4294967295:0", kind: "trade_buy", presale_id: ID });
    });
    await settle();
    assert.equal(reads.at(-1), `${activityPath}&at=103`, "a hint without a trade frame still fetches");
    assert.equal(chartCues().length, 3, "the hint-only fallback still cues the buy");

    now += 6_000;
    latestCheckpoint = 104;
    pollCanSeeLatest = true;
    const next = new Promise<EventStream>(resolve => { reconnected = resolve; });
    await act(async () => {
      source?.receive({}, "resync");
      const resumed = await next;
      resumed.receive({ type: "hello", provenance: infraProvenanceFixture({ deployment_fingerprint: null }) });
      resumed.receive({ type: "pong", presale_checkpoint: 104 });
    });
    await settle();
    assert.equal(headline.querySelector("[data-trade-cue]")?.getAttribute("data-trade-cue"), "sell");
    assert.equal(chartCues().length, 3, "the catch-up read is quiet");
    assert.equal(status(), "New buy", "the catch-up sell cannot replace the live announcement");

    now += 6_000;
    latestCheckpoint = 105;
    await emitTrade(105, ID, CREATE_SUI_QUOTE_TYPE, await next);
    await settle();
    assert.equal(container.querySelector('ol[aria-label="Recent trades"] > li [data-side]')?.getAttribute("data-side"), "sell", "a sub-dollar live buy stays hidden");
    const historyStream = new Promise<EventStream>(resolve => { reconnected = resolve; });
    await act(async () => {
      (await next).receive({}, "resync");
      const resumed = await historyStream;
      resumed.receive({ type: "hello", provenance: infraProvenanceFixture({ deployment_fingerprint: null }) });
      resumed.receive({ type: "pong", presale_checkpoint: 105 });
    });
    await settle();
    assert.equal(reads.at(-1), `${activityPath}&at=105`, "the history read includes the sub-dollar trade");
    assert.match(panel() ?? "", /No trades match this filter/, "a history read retains the exact dollar threshold");
    const filter = container.querySelector<HTMLButtonElement>('button[role="switch"]');
    assert.ok(filter);
    await act(async () => filter.click());
    assert.equal(container.querySelector('ol[aria-label="Recent trades"] > li [data-side]')?.getAttribute("data-side"), "buy", "the switch reveals the small trade");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    if (beforeSource) Object.defineProperty(globalThis, "EventSource", beforeSource);
    else Reflect.deleteProperty(globalThis, "EventSource");
  }
});
