import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { SocialTradeQuote, SocialTradeQuoteRequest } from "@blast/core/modules/social/contracts/trades.ts";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

/**
 * The quote every trade surface asks while the person types (R3-55, shared
 * with R3-33/R3-34), through the one engine (`trade-quote-query.ts`, a
 * TanStack Query read) under the shared policy: debounced, one in
 * flight, the last one wins, re-asked before the `quote_id` expires (R3-30's
 * 20 s), a refusal retried after its `Retry-After`. The clock and the timers
 * are the test's (the hook runs on the surface's timers; `Date` follows the
 * same clock).
 */

const dom = installTestDom();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { fixtureCoinType, fixtureTradeQuote, fixtureWallet, FIXTURE_USDC } = await import("../../../../test/fixtures/social/trade/trade-fixtures.ts");
const { TRADE_QUOTE_DEBOUNCE_MS, TRADE_QUOTE_RETRY_MS, TRADE_QUOTE_SHOWN_REFRESH_MS, tradeQuoteKey } = await import("./trade-quotes");
type TradeQuoteAnswer = import("./trade-quotes").TradeQuoteAnswer;
const { useTradeQuoteQuery } = await import("./trade-quote-query");
type TradeQuoteState = import("./trade-quote-query").TradeQuoteState;

const KSTL = fixtureCoinType("KSTL");
const buy = (usdc: number): SocialTradeQuoteRequest => ({ in_coin: FIXTURE_USDC, out_coin: KSTL, side: "buy", amount_in: String(usdc * 1_000_000) });

/** Lets answers land and TanStack Query tell its observers (on a later macrotask). */
const flush = async () => {
  for (let i = 0; i < 3; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
};

/** `Date` follows each test's hand clock (TanStack Query stamps answers with it). */
const clocked = new WeakSet<TestContext>();

type Ask = Readonly<{ request: SocialTradeQuoteRequest | null; scope?: string; now?: boolean }>;

async function harness(t: TestContext) {
  if (!clocked.has(t)) {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    clocked.add(t);
  }
  let now = Date.now();
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  const asked: SocialTradeQuoteRequest[] = [];
  const pending: { request: SocialTradeQuoteRequest; signal: AbortSignal | undefined; resolve: (answer: TradeQuoteAnswer) => void }[] = [];
  let open = 0;
  let most = 0;
  const kit = {
    quote: (request: SocialTradeQuoteRequest, signal?: AbortSignal) =>
      new Promise<TradeQuoteAnswer>((resolve) => {
        asked.push(request);
        open += 1;
        most = Math.max(most, open);
        let done = false;
        const close = () => {
          if (!done) open -= 1;
          done = true;
        };
        signal?.addEventListener("abort", close, { once: true });
        pending.push({ request, signal, resolve: (answer) => (close(), resolve(answer)) });
      }),
  };
  const clock = {
    after: (run: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clear: (handle: number) => void timers.delete(handle),
  };
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  let latest: TradeQuoteState | null = null;
  let current: Ask = { request: null };
  function Probe({ ask }: Readonly<{ ask: Ask }>) {
    latest = useTradeQuoteQuery({
      read: kit.quote,
      request: ask.request,
      ...(ask.scope === undefined ? {} : { scope: ask.scope }),
      ...(ask.now === undefined ? {} : { now: ask.now }),
      timers: { after: clock.after, clear: (handle) => clock.clear(handle as number) },
      policy: { shownRefreshMs: TRADE_QUOTE_SHOWN_REFRESH_MS, retryMs: TRADE_QUOTE_RETRY_MS },
    });
    return null;
  }
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  let root = createRoot(container as unknown as Element);
  const draw = () => act(async () => root.render(withQueryClient(client, <Probe ask={current} />)));
  await draw();
  return {
    asked,
    pending,
    timers,
    most: () => most,
    now: () => now,
    peek: () => latest!,
    /** What is typed now (a re-render with the new request). */
    async ask(request: SocialTradeQuoteRequest | null, options: Readonly<{ now?: boolean; scope?: string }> = {}) {
      current = { request, ...options };
      await draw();
      await flush();
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        t.mock.timers.tick(due[1].at - now);
        now = due[1].at;
        await act(async () => due[1].run());
        await flush();
      }
      t.mock.timers.tick(until - now);
      now = until;
      await flush();
    },
    async answer(quote: (request: SocialTradeQuoteRequest) => TradeQuoteAnswer) {
      const out = pending.shift();
      assert.ok(out, "a quote is out");
      await act(async () => out.resolve(quote(out.request)));
      await flush();
    },
    offered: (request: SocialTradeQuoteRequest): TradeQuoteAnswer => ({ status: "ok", quote: fixtureTradeQuote(request, { signedIn: true, nowMs: now, wallet: fixtureWallet() }) }),
    /** The surface leaves (unmounts), then, `again`, comes back. */
    async leave() {
      await act(async () => root.unmount());
      root = createRoot(container as unknown as Element);
    },
    draw,
    async close() {
      await act(async () => root.unmount());
      container.parentNode?.removeChild(container);
      client.clear();
    },
  };
}

test("typing fast asks once, after the amount stops changing (R3-33-AC-6's rule, shared)", async (t) => {
  const h = await harness(t);
  for (const usd of [1, 10, 100]) {
    await h.ask(buy(usd));
    await h.advance(100);
  }
  assert.equal(h.asked.length, 0, "nothing while typing");
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  assert.deepEqual(h.asked, [buy(100)], "one quote, for what is typed now");
  assert.equal(h.peek().loading, true);
  await h.answer(h.offered);
  const snapshot = h.peek();
  assert.equal(snapshot.key, tradeQuoteKey(buy(100)));
  assert.equal(snapshot.quote?.amount_in, "100000000");
  assert.equal(snapshot.loading, false);
  await h.close();
});

test("one in flight: a change while a quote is out stops it; its stale answer is never shown, and the wanted amount is asked once typing pauses", async (t) => {
  const h = await harness(t);
  await h.ask(buy(50), { now: true });
  assert.equal(h.asked.length, 1);
  const fifty = h.pending[0]!;
  await h.ask(buy(100));
  assert.equal(fifty.signal?.aborted, true, "nobody wants $50 now: its read is stopped");
  await h.ask(buy(500));
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS * 4);
  assert.deepEqual(h.asked.at(-1), buy(500), "the wanted amount is asked, once");
  assert.equal(h.asked.length, 2);
  await h.answer(h.offered);
  assert.equal(h.peek().quote, null, "the $50 answer, landing late, is dropped");
  await h.answer(h.offered);
  assert.equal(h.peek().quote?.amount_in, "500000000");
  assert.equal(h.most(), 1, "never two quotes out at once");
  await h.close();
});

test("an offered quote is asked again two seconds before it expires; a browser-routed one every 20 s; a server answer shown only is not", async (t) => {
  const h = await harness(t);
  await h.ask(buy(100), { now: true });
  await h.answer(h.offered);
  const first = h.peek().quote as SocialTradeQuote;
  assert.equal(first.expires_at_ms, h.now() + 20_000);
  await h.advance(17_900);
  assert.equal(h.asked.length, 1);
  await h.advance(200);
  assert.equal(h.asked.length, 2, "re-asked at 18 s");
  assert.equal(h.peek().quote, first, "the quote on screen stays while the next is out");
  await h.answer(h.offered);
  await h.close();

  const visitor = await harness(t);
  await visitor.ask(buy(100), { now: true, scope: "out" });
  await visitor.answer((request) => ({ status: "ok", quote: fixtureTradeQuote(request, { signedIn: false, nowMs: visitor.now() }), routed: true }));
  assert.equal(visitor.peek().quote?.quote_id, null);
  await visitor.advance(TRADE_QUOTE_SHOWN_REFRESH_MS);
  assert.equal(visitor.asked.length, 2, "the browser's own route is priced again every 20 s");
  await visitor.close();

  const shown = await harness(t);
  await shown.ask(buy(100), { now: true, scope: "out" });
  await shown.answer((request) => ({ status: "ok", quote: fixtureTradeQuote(request, { signedIn: false, nowMs: shown.now() }) }));
  await shown.advance(TRADE_QUOTE_SHOWN_REFRESH_MS * 3);
  assert.equal(shown.asked.length, 1, "no idle server re-quote");
  await shown.close();
});

test("a refused quote keeps the last answer and is asked again after its Retry-After", async (t) => {
  const h = await harness(t);
  await h.ask(buy(100), { now: true });
  await h.answer(h.offered);
  await act(async () => h.peek().refresh());
  await h.answer(() => ({ status: "refused", code: "rate_limited", retryAfterSeconds: 7, requestId: "composer-quote-reference", httpStatus: 429 }));
  assert.equal(h.peek().error?.code, "rate_limited");
  assert.equal(h.peek().error?.requestId, "composer-quote-reference");
  assert.equal(h.peek().error?.httpStatus, 429);
  assert.ok(h.peek().quote !== null, "the answer on screen stays");
  assert.equal(h.peek().loading, false, "nothing is out while it waits");
  await h.advance(6_900);
  assert.equal(h.asked.length, 2);
  await h.advance(100);
  assert.equal(h.asked.length, 3);
  await h.close();
  // A first ask that fails leaves nothing to show for that amount.
  const cold = await harness(t);
  await cold.ask(buy(5), { now: true });
  await cold.answer(() => ({ status: "error" }));
  assert.deepEqual({ key: cold.peek().key, quote: cold.peek().quote, failed: cold.peek().error?.code }, { key: tradeQuoteKey(buy(5)), quote: null, failed: "network_unavailable" });
  await cold.close();
});

test("who asks is part of the request: a sign-in asks the same amount again", async (t) => {
  const h = await harness(t);
  await h.ask(buy(100), { now: true, scope: "out" });
  await h.answer(h.offered);
  await h.ask(buy(100), { now: true, scope: "out" });
  assert.equal(h.asked.length, 1, "the same request is not asked twice");
  await h.ask(buy(100), { now: true, scope: "in" });
  assert.equal(h.asked.length, 2);
  await h.close();
});

test("nothing to ask clears the answer; leaving stops every timer and drops the answer still out", async (t) => {
  const h = await harness(t);
  await h.ask(buy(100), { now: true });
  await h.answer(h.offered);
  await h.ask(null);
  assert.equal(h.peek().quote, null);
  assert.equal(h.timers.size, 0, "no re-ask for an amount nobody wants");
  await h.ask(buy(250), { now: true });
  const out = h.pending[0]!;
  await h.leave();
  assert.equal(out.signal?.aborted, true, "leaving stops the quote still out");
  await h.answer(h.offered);
  assert.equal(h.timers.size, 0);
  // The surface comes back with the same amount: its quote was stopped, so it is asked afresh, once.
  await h.ask(buy(250), { now: true });
  assert.equal(h.asked.length, 3, "and asking again afterwards starts afresh");
  await h.close();
});
