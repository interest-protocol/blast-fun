import { queryKeys } from "#web/lib/query/keys.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { SocialTradeQuote, SocialTradeQuoteRequest } from "@blast/core/modules/social/contracts/trades.ts";

import type { ApiResult } from "#web/components/social/social-api.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

/**
 * Social feed R3-33-AC-6: the swap asks R3-30's quote route after a pause in
 * typing, with at most one request in flight (a newer question aborts the
 * older, whose answer is then dropped), keeps an offered quote fresh by
 * asking again 2 s before its 20 s expiry, and tells the screen when a quote
 * expires so the button turns off. A manual clock drives every timer (the
 * hook's own, and `Date`, which the query cache stamps answers with).
 *
 * OA-38: the swap runs on the one trade-quote engine
 * (`trade/trade-quote-query.ts`); each test drives it as the trade screen
 * does — a new question is a re-render, a running trade is `held`, the
 * screen going away is an unmount.
 */

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { tradeRequestKey } = await import("../trade/trade-quotes.ts");
const { TRADE_QUOTE_DEBOUNCE_MS: QUOTE_DEBOUNCE_MS } = await import("../trade/trade-quotes.ts");
const { useTradeQuoteQuery } = await import("../trade/trade-quote-query.ts");
const { tradeQuoteReader } = await import("../trades/trades-client.ts");
type TradeQuoteSnapshot = import("../trade/trade-quotes.ts").TradeQuoteSnapshot;

const settleAll = async () => {
  for (let i = 0; i < 3; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
};

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: 1_791_000_000_000 });
  let now = Date.now();
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    after: (run: () => void, ms: number) => {
      next += 1;
      timers.set(next, { at: now + ms, run });
      return next;
    },
    clear: (id: unknown) => void timers.delete(id as number),
    /** Moves the clock, running each timer that comes due, in order. */
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t.mock.timers.tick(due[1].at - now);
        now = due[1].at;
        await act(async () => due[1].run());
        await settleAll();
      }
      t.mock.timers.tick(until - now);
      now = until;
      await settleAll();
    },
    pending: () => timers.size,
  };
}

type Requester = (request: SocialTradeQuoteRequest, signal: AbortSignal) => Promise<ApiResult<SocialTradeQuote>>;

/**
 * The trade screen's side of the hook, as the old engine's interface: `set`
 * the question on screen, `hold` while a trade runs, `stop` (the screen goes
 * away; the next `set` brings it back), the latest `snapshot`, `refresh`.
 */
async function screen(
  time: ReturnType<typeof clock>,
  request: Requester,
  options: Readonly<{ seed?: Readonly<{ request: SocialTradeQuoteRequest; quote: SocialTradeQuote }>; client?: ReturnType<typeof createTestQueryClient> }> = {},
) {
  const client = options.client ?? createTestQueryClient({ queries: { gcTime: 60_000 } });
  let latest: Readonly<{ snapshot: TradeQuoteSnapshot; refresh: () => void }> | null = null;
  let renders = 0;
  let question: SocialTradeQuoteRequest | null = options.seed?.request ?? null;
  let held = false;
  let scope = "";
  if (options.seed) {
    const request = options.seed.request;
    client.setQueryData(queryKeys.quotes.swap({viewer: null, scope: "", side: request.side, in_coin: request.in_coin, out_coin: request.out_coin, amount_in: request.amount_in ?? null, amount_out: request.amount_out ?? null, slippage_bps: request.slippage_bps ?? null}), {quote: options.seed.quote, at: options.seed.quote.quoted_at_ms});
  }
  function Probe() {
    const quote = useTradeQuoteQuery({ read: tradeQuoteReader(request), request: question, held, timers: time, scope });
    latest = { snapshot: quote, refresh: () => quote.refresh({ cancel: true }) };
    renders += 1;
    return null;
  }
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | null = null;
  const draw = async () => {
    root ??= createRoot(container as unknown as Element);
    await act(async () => root!.render(withQueryClient(client, <Probe />)));
    await settleAll();
  };
  await draw();
  return {
    snapshot: () => latest!.snapshot,
    renders: () => renders,
    async set(next: SocialTradeQuoteRequest | null) {
      question = next;
      await draw();
    },
    async scope(next: string) { scope = next; await draw(); },
    async hold(next: boolean) {
      held = next;
      await draw();
    },
    async refresh() {
      await act(async () => latest!.refresh());
      await settleAll();
    },
    async stop() {
      const gone = root;
      root = null;
      if (gone) await act(async () => gone.unmount());
      await settleAll();
    },
  };
}

const body = (amount: string): SocialTradeQuoteRequest => ({ in_coin: "0x2::sui::SUI", out_coin: "0xu::usdc::USDC", side: "sell", amount_in: amount });

function quoteFor(request: SocialTradeQuoteRequest, nowMs: number, offered = true): SocialTradeQuote {
  return {
    quote_id: offered ? `q1.${request.amount_in}-${nowMs}` : null, expires_at_ms: offered ? nowMs + 20_000 : null, quoted_at_ms: nowMs, side: request.side,
    in_coin: request.in_coin, out_coin: request.out_coin, amount_in: request.amount_in ?? null, amount_out: "1", min_out: "1", slippage_bps: 50,
    price_impact_bps: 0, price_impact_unavailable: null, fee_bps: 0, fee_amount: "0", blast_fee_bps: 0, blast_fee_amount: "0", route: [], route_label: null, price_per_out: null,
    amount_in_usd: null, amount_out_usd: null, network_fee: null, dry_run: offered ? "passed" : "not_run", offer_refused: null, unavailable_reason: null,
  };
}

/** A quote route whose answers the test releases one by one, logging what is in flight. */
function route(time: ReturnType<typeof clock>) {
  const calls: { body: SocialTradeQuoteRequest; signal: AbortSignal; answer: (result: ApiResult<SocialTradeQuote>) => void }[] = [];
  let inFlight = 0;
  let most = 0;
  return {
    calls,
    most: () => most,
    inFlight: () => inFlight,
    request(request: SocialTradeQuoteRequest, signal: AbortSignal): Promise<ApiResult<SocialTradeQuote>> {
      inFlight += 1;
      most = Math.max(most, inFlight);
      const settle = () => void (inFlight -= 1);
      signal.addEventListener("abort", settle, { once: true });
      return new Promise((resolve) => {
        calls.push({
          body: request,
          signal,
          answer: (result) => {
            if (!signal.aborted) {
              signal.removeEventListener("abort", settle);
              settle();
            }
            resolve(result);
          },
        });
      });
    },
    ok: (index: number) => calls[index]!.answer({ status: "ok", body: quoteFor(calls[index]!.body, time.now()), httpStatus: 200 }),
  };
}

test("fast typing asks once after the pause, never per keystroke, and at most one request is ever in flight", async (t) => {
  const time = clock(t);
  const quotes = route(time);
  const engine = await screen(time, (b, s) => quotes.request(b, s));
  for (const amount of ["1", "10", "100", "1000"]) {
    await engine.set(body(amount));
    await time.advance(80);
  }
  assert.equal(quotes.calls.length, 0, "still typing");
  assert.equal(engine.snapshot().loading, true, "the button is off from the first keystroke");
  await time.advance(QUOTE_DEBOUNCE_MS);
  assert.deepEqual(quotes.calls.map((call) => call.body.amount_in), ["1000"], "only the last amount");
  // A new amount while the first is in flight aborts it; the old answer, even if it lands, is dropped.
  await engine.set(body("1001"));
  assert.equal(quotes.calls[0]!.signal.aborted, true);
  await time.advance(QUOTE_DEBOUNCE_MS);
  assert.equal(quotes.calls.length, 2);
  quotes.ok(0);
  await time.advance(1);
  assert.equal(engine.snapshot().quote, null, "an aborted answer never lands");
  quotes.ok(1);
  await time.advance(1);
  assert.equal(engine.snapshot().quote?.amount_in, "1001");
  assert.equal(engine.snapshot().key, tradeRequestKey(body("1001")));
  assert.equal(engine.snapshot().loading, false);
  assert.equal(quotes.most(), 1, "never two in flight");
});

test("an offered quote is asked again 2 s before it expires, and the screen hears the expiry if no fresh one arrived", async (t) => {
  const time = clock(t);
  const quotes = route(time);
  const engine = await screen(time, (b, s) => quotes.request(b, s));
  await engine.set(body("5"));
  await time.advance(QUOTE_DEBOUNCE_MS);
  quotes.ok(0);
  await time.advance(1);
  const first = engine.snapshot().quote!;
  await time.advance(17_000);
  assert.equal(quotes.calls.length, 1, "not yet: 18 s of 20 have not passed");
  await time.advance(1_000);
  assert.equal(quotes.calls.length, 2, "asked again 2 s before expiry");
  assert.equal(engine.snapshot().loading, true, "the button is off while the refresh is in flight");
  assert.equal(engine.snapshot().quote, first, "the screen keeps its numbers meanwhile");
  // The refresh does not answer before the old quote expires: the screen is told, so the button reads it as stale.
  const before = engine.renders();
  await time.advance(2_000);
  assert.ok(engine.renders() > before, "a render at expiry");
  assert.ok(time.now() >= first.expires_at_ms!);
  quotes.ok(1);
  await time.advance(1);
  assert.notEqual(engine.snapshot().quote, first, "the fresh quote replaces it");
  assert.equal(quotes.most(), 1);
});

test("a refusal is kept as its code; rate_limited is asked again after Retry-After; a held engine does not refresh mid-trade", async (t) => {
  const time = clock(t);
  const quotes = route(time);
  const engine = await screen(time, (b, s) => quotes.request(b, s));
  await engine.set(body("7"));
  await time.advance(QUOTE_DEBOUNCE_MS);
  quotes.calls[0]!.answer({ status: "refused", code: "rate_limited", retryAfterSeconds: 3, requestId: "quote-rate-fixture", httpStatus: 429 });
  await time.advance(1);
  assert.deepEqual(engine.snapshot().error, { code: "rate_limited", retryAfterSeconds: 3, requestId: "quote-rate-fixture", httpStatus: 429 });
  assert.equal(engine.snapshot().loading, false);
  await time.advance(3_000);
  assert.equal(quotes.calls.length, 2, "asked again after Retry-After");
  quotes.ok(1);
  await time.advance(1);
  assert.equal(engine.snapshot().error, null);
  await engine.hold(true);
  await time.advance(20_000);
  assert.equal(quotes.calls.length, 2, "no refresh while a trade runs");
  await engine.hold(false);
  await time.advance(1_000);
  assert.equal(quotes.calls.length, 3, "asked again once it ends");
});

test("clearing the amount clears the question; a screen that comes back asks again; a seeded answer is shown without asking", async (t) => {
  const time = clock(t);
  const quotes = route(time);
  const engine = await screen(time, (b, s) => quotes.request(b, s));
  await engine.set(body("9"));
  await time.advance(QUOTE_DEBOUNCE_MS);
  await engine.set(null);
  assert.equal(quotes.calls[0]!.signal.aborted, true);
  assert.deepEqual([engine.snapshot().key, engine.snapshot().loading], [null, false]);
  await engine.set(body("9"));
  await engine.stop();
  assert.equal(time.pending(), 0, "stopping leaves nothing scheduled");
  await engine.set(body("9"));
  await time.advance(QUOTE_DEBOUNCE_MS);
  assert.equal(quotes.calls.length, 2, "the same question, asked again after the screen came back");

  const seeded = quoteFor(body("3"), time.now());
  const shown = await screen(time, (b, s) => quotes.request(b, s), { seed: { request: body("3"), quote: seeded } });
  assert.equal(shown.snapshot().quote, seeded);
  await shown.set(body("3"));
  await time.advance(QUOTE_DEBOUNCE_MS);
  assert.equal(quotes.calls.length, 2, "nothing asked for an answer in hand");
  await time.advance(18_000);
  assert.equal(quotes.calls.length, 3, "kept fresh like any other");
});


test("a failed quote preserves its safe code and response reference", async (t) => {
  const time = clock(t);
  const quotes = route(time);
  const engine = await screen(time, (body, signal) => quotes.request(body, signal));
  t.after(() => engine.stop());
  await engine.set(body("7"));
  await time.advance(QUOTE_DEBOUNCE_MS);
  quotes.calls[0]!.answer({ status: "error", code: "service_unavailable", httpStatus: 503, requestId: "quote-outage-fixture" });
  await time.advance(1);
  assert.deepEqual(engine.snapshot().error, { code: "service_unavailable", retryAfterSeconds: null, httpStatus: 503, requestId: "quote-outage-fixture" });
  assert.equal(engine.snapshot().quote, null);
  assert.equal(engine.snapshot().loading, false);
});

for (const blocked of ["pool_unavailable", "not_tradable"] as const) {
  test(`a migrated pool recovers from ${blocked} without changing the amount, and pauses during a trade`, async t => {
    const time = clock(t);
    const quotes = route(time);
    const engine = await screen(time, (body, signal) => quotes.request(body, signal));
    t.after(() => engine.stop());
    await engine.set(body("7"));
    await time.advance(QUOTE_DEBOUNCE_MS);
    quotes.calls[0]!.answer(blocked === "pool_unavailable" ? { status: "refused", code: blocked, retryAfterSeconds: null } : { status: "ok", httpStatus: 200, body: { ...quoteFor(body("7"), time.now(), false), unavailable_reason: blocked } });
    await time.advance(1);
    await engine.hold(true);
    await time.advance(6_000);
    assert.equal(quotes.calls.length, 1, "the quote used by a running trade stays pinned");
    await engine.hold(false);
    await time.advance(5_000);
    assert.equal(quotes.calls.length, 2, "the same amount is asked again when the pool is ready");
    quotes.ok(1);
    await time.advance(1);
    assert.ok(engine.snapshot().quote?.quote_id);
    assert.equal(engine.snapshot().error, null);
  });
}

test("no_pool is shown and not asked again until the amount changes", async t => {
  const time = clock(t);
  const quotes = route(time);
  const engine = await screen(time, (body, signal) => quotes.request(body, signal));
  t.after(() => engine.stop());
  await engine.set(body("7"));
  await time.advance(QUOTE_DEBOUNCE_MS);
  quotes.calls[0]!.answer({ status: "ok", httpStatus: 200, body: { ...quoteFor(body("7"), time.now(), false), unavailable_reason: "no_pool" } });
  await time.advance(1);
  await time.advance(60_000);
  assert.equal(quotes.calls.length, 1, "nothing routes this pair: no re-ask on a timer");
  assert.equal(engine.snapshot().quote?.unavailable_reason, "no_pool");
  await engine.set(body("8"));
  await time.advance(QUOTE_DEBOUNCE_MS);
  assert.equal(quotes.calls.length, 2, "a new amount is asked");
});

test("a shown pool outage quote is retried without an amount edit", async t => {
  const time = clock(t);
  const quotes = route(time);
  const engine = await screen(time, (body, signal) => quotes.request(body, signal));
  t.after(() => engine.stop());
  await engine.set(body("7"));
  await time.advance(QUOTE_DEBOUNCE_MS);
  quotes.calls[0]!.answer({ status: "ok", httpStatus: 200, body: { ...quoteFor(body("7"), time.now(), false), unavailable_reason: "pool_unavailable" } });
  await time.advance(1);
  await time.advance(5_000);
  assert.equal(quotes.calls.length, 2);
  quotes.ok(1);
  await time.advance(1);
  assert.ok(engine.snapshot().quote?.quote_id);
});

 test("a different presale or wallet scope cannot reuse an offered payment quote", async (t) => {
  const time = clock(t);
  const quotes = route(time);
  const engine = await screen(time, (b, s) => quotes.request(b, s));
  t.after(() => engine.stop());
  await engine.scope("sale-a:mainnet:wallet-a");
  await engine.set(body("5"));
  await time.advance(QUOTE_DEBOUNCE_MS);
  quotes.ok(0);
  await time.advance(1);
  assert.ok(engine.snapshot().quote);
  await engine.scope("sale-b:mainnet:wallet-a");
  assert.equal(engine.snapshot().quote, null);
  await time.advance(QUOTE_DEBOUNCE_MS);
  quotes.ok(1);
  await time.advance(1);
  assert.ok(engine.snapshot().quote);
  await engine.scope("sale-b:mainnet:wallet-b");
  assert.equal(engine.snapshot().quote, null);
  await time.advance(QUOTE_DEBOUNCE_MS);
  assert.equal(quotes.calls.length, 3);
});
