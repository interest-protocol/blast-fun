import { queryKeys } from "#web/lib/query/keys.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ReactNode } from "react";

import type { SocialTradeQuoteRequest } from "@blast/core/modules/social/contracts/trades.ts";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

/**
 * OA-38: the one trade-quote engine (`useTradeQuoteQuery`) as a TanStack Query
 * read. Its cache is keyed by the request and the viewer, so a quote is never
 * reused for someone else, and an amount asked again while its answer is
 * still fresh costs no request; a running trade holds every re-ask; the
 * surface draws again the moment a quote expires; a seeded answer is shown
 * without asking and kept fresh like any other. Hand clock and hand timers.
 */

const dom = installTestDom();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { SocialViewerProvider } = await import("../SignInGate");
const { fixtureCoinType, fixtureTradeQuote, fixtureWallet, FIXTURE_USDC } = await import("../../../../test/fixtures/social/trade/trade-fixtures.ts");
const { TRADE_QUOTE_DEBOUNCE_MS } = await import("./trade-quotes");
type TradeQuoteAnswer = import("./trade-quotes").TradeQuoteAnswer;
const { useTradeQuoteQuery } = await import("./trade-quote-query");
type TradeQuoteState = import("./trade-quote-query").TradeQuoteState;

const KSTL = fixtureCoinType("KSTL");
const sell = (atoms: string): SocialTradeQuoteRequest => ({ in_coin: KSTL, out_coin: FIXTURE_USDC, side: "sell", amount_in: atoms });

const flush = async () => {
  for (let i = 0; i < 3; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
};

type Props = Readonly<{ request: SocialTradeQuoteRequest | null; viewer: string | null; held?: boolean; now?: boolean; prefetch?: readonly SocialTradeQuoteRequest[] }>;

async function harness(t: TestContext, client = createTestQueryClient({ queries: { gcTime: 60_000 } })) {
  t.mock.timers.enable({ apis: ["Date"], now: 1_791_000_000_000 });
  let now = Date.now();
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  const asked: SocialTradeQuoteRequest[] = [];
  const pending: { request: SocialTradeQuoteRequest; resolve: (answer: TradeQuoteAnswer) => void }[] = [];
  // A kit that answers in the same turn it is asked (as Blast mode's test kit does), or null: answered by hand.
  let atOnce: TradeQuoteAnswer | null = null;
  const read = (request: SocialTradeQuoteRequest) =>
    new Promise<TradeQuoteAnswer>((resolve) => {
      asked.push(request);
      if (atOnce !== null) resolve(atOnce);
      else pending.push({ request, resolve });
    });
  const clock = {
    after: (run: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clear: (handle: unknown) => void timers.delete(handle as number),
  };
  let latest: TradeQuoteState | null = null;
  let renders = 0;
  function Probe({ props }: Readonly<{ props: Props }>) {
    latest = useTradeQuoteQuery({ read, request: props.request, held: props.held === true, now: props.now === true, timers: clock, prefetch: props.prefetch });
    renders += 1;
    return null;
  }
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const tree = (props: Props): ReactNode =>
    withQueryClient(
      client,
      <SocialViewerProvider callsign={props.viewer} getAccessToken={async () => null} signedIn={props.viewer !== null}>
        <Probe props={props} />
      </SocialViewerProvider>,
    );
  return {
    client,
    timers,
    asked,
    renders: () => renders,
    peek: () => latest!,
    answerAtOnce(answer: TradeQuoteAnswer | null) {
      atOnce = answer;
    },
    now: () => now,
    async show(props: Props) {
      await act(async () => root.render(tree(props)));
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
        await act(async () => {
          due[1].run();
          // A kit that answers at once has answered before React draws what the timer set (as outside a test,
          // where that draw waits for the scheduler): let its answer land first.
          if (atOnce !== null) await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await flush();
      }
      t.mock.timers.tick(until - now);
      now = until;
      await flush();
    },
    async answer(offered = true) {
      const out = pending.shift();
      assert.ok(out, "a quote is out");
      const quote = fixtureTradeQuote(out.request, offered ? { signedIn: true, nowMs: now, wallet: fixtureWallet() } : { signedIn: false, nowMs: now });
      await act(async () => out.resolve({ status: "ok", quote }));
      await flush();
    },
    async close() {
      await act(async () => root.unmount());
      container.parentNode?.removeChild(container);
    },
  };
}

test("the cache is keyed by the viewer: the same amount for someone else is asked again, never served from another's answer", async (t) => {
  const h = await harness(t);
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.answer();
  assert.equal(h.asked.length, 1);
  // Kai signs out and Mira signs in, inside the quote's 20 s.
  await h.show({ request: sell("1000"), viewer: "mira" });
  assert.equal(h.peek().quote, null, "Kai's quote is not Mira's");
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  assert.equal(h.asked.length, 2, "Mira's own dry run");
  await h.close();
});

test("an amount asked again while its answer is fresh reads the cache: typing back costs no request", async (t) => {
  const h = await harness(t);
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.answer();
  const first = h.peek().quote;
  await h.show({ request: sell("2000"), viewer: "kai" });
  assert.equal(h.peek().quote, null, "a new amount has no answer yet");
  assert.equal(h.peek().shown, first, "the last answer stays readable while it is asked");
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.answer();
  await h.show({ request: sell("1000"), viewer: "kai" });
  assert.equal(h.peek().quote, first, "back to 1000 inside its 18 s: the answer in the cache");
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  assert.equal(h.asked.length, 2, "and no request for it");
  await h.close();
});

test("a running trade holds every re-ask; the quote is asked again once it ends", async (t) => {
  const h = await harness(t);
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.answer();
  await h.show({ request: sell("1000"), viewer: "kai", held: true });
  await h.advance(25_000);
  assert.equal(h.asked.length, 1, "nothing replaces the quote a trade is using");
  await h.show({ request: sell("1000"), viewer: "kai", held: false });
  await h.advance(1_000);
  assert.equal(h.asked.length, 2, "asked again once it ends");
  await h.close();
});

test("the surface draws again the moment an offered quote expires, even with no answer to replace it", async (t) => {
  const h = await harness(t);
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.answer();
  const quote = h.peek().quote!;
  await h.advance(18_000);
  assert.equal(h.asked.length, 2, "asked again 2 s before it expires");
  assert.equal(h.peek().loading, true);
  const before = h.renders();
  await h.advance(quote.expires_at_ms! - h.now());
  assert.ok(h.renders() > before, "a draw at expiry");
  assert.equal(h.peek().quote, quote, "the numbers stay until the next answer");
  await h.close();
});

test("an expiry timer that fires early waits for the quote's actual deadline", async (t) => {
  const h = await harness(t);
  t.after(() => h.close());
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.answer();
  const deadline = h.peek().quote!.expires_at_ms!;
  await h.advance(deadline - h.now() - 1);
  const expiry = [...h.timers.entries()].find(([, timer]) => timer.at === deadline)!;
  assert.ok(expiry);
  h.timers.delete(expiry[0]);
  await act(async () => expiry[1].run());
  assert.ok(h.peek().nowMs < deadline, "an early callback leaves the quote eligible until its deadline");
  await h.advance(1);
  assert.equal(h.peek().nowMs, deadline, "the rescheduled expiry makes the quote ineligible on time");
});

test("a seeded answer is shown without asking, and kept fresh like any other", async (t) => {
  const h = await harness(t);
  const seed = fixtureTradeQuote(sell("3000"), { signedIn: true, nowMs: Date.now(), wallet: fixtureWallet() });
  const request = sell("3000");
  h.client.setQueryData(queryKeys.quotes.swap({viewer: "kai", scope: "", side: request.side, in_coin: request.in_coin, out_coin: request.out_coin, amount_in: request.amount_in ?? null, amount_out: request.amount_out ?? null, slippage_bps: request.slippage_bps ?? null}), {quote: seed, at: seed.quoted_at_ms});
  await h.show({ request, viewer: "kai" });
  assert.equal(h.peek().quote, seed);
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  assert.equal(h.asked.length, 0, "nothing asked for an answer in hand");
  await h.advance(18_000);
  assert.equal(h.asked.length, 1, "asked again 2 s before it expires");
  await h.close();
});

test("a question whose read failed at once is read once: enabling the query after the pause does not ask it again (R3-55)", async (t) => {
  const h = await harness(t);
  h.answerAtOnce({ status: "error" });
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  assert.equal(h.asked.length, 1, "the pause's read, and only it");
  assert.equal(h.peek().error?.code, "network_unavailable");
  await h.advance(30_000);
  assert.equal(h.asked.length, 1, "no due time for a plain failure under the default policy: nothing asks it again");
  // Asked at once (a preset): a new question is read once; one that failed before is read again, once.
  await h.show({ request: sell("2000"), viewer: "kai", now: true });
  assert.equal(h.asked.length, 2, "`now` asks without the pause");
  await h.show({ request: sell("1000"), viewer: "kai", now: true });
  assert.equal(h.asked.length, 3, "back to a failed amount with `now`: asked again");
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS + 30_000);
  assert.equal(h.asked.length, 3, "and only once");
  await h.close();
});

function pageVisibility(t: TestContext) {
  let visibility: DocumentVisibilityState = "visible";
  t.mock.getter(dom.document, "visibilityState", () => visibility);
  return async (next: DocumentVisibilityState) => {
    visibility = next;
    await act(async () => dom.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    await flush();
  };
}

test("hidden tabs cancel scheduled quote refresh and a fresh return keeps the original due time", async (t) => {
  const visible = pageVisibility(t);
  const h = await harness(t);
  t.after(() => h.close());
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.answer();
  const quote = h.peek().quote!;
  await h.advance(5_000);
  await visible("hidden");
  assert.equal(h.timers.size, 1, "only the expiry draw remains, not the provider re-ask");
  await h.advance(5_000);
  assert.equal(h.asked.length, 1);
  await visible("visible");
  await h.advance(quote.expires_at_ms! - 2_000 - h.now() - 1);
  assert.equal(h.asked.length, 1, "returning does not refresh a fresh quote");
  await h.advance(1);
  assert.equal(h.asked.length, 2, "the original deadline is retained");
});

test("returning after hidden expiry updates eligibility even when the browser deferred its expiry timer", async (t) => {
  const visible = pageVisibility(t);
  const h = await harness(t);
  t.after(() => h.close());
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.answer();
  const quote = h.peek().quote!;
  await visible("hidden");
  // Model a browser that suspends the tab's expiry callback until after visibilitychange.
  const expiry = [...h.timers.entries()].find(([, timer]) => timer.at === quote.expires_at_ms)!;
  h.timers.delete(expiry[0]);
  await h.advance(25_000);
  assert.equal(h.asked.length, 1, "hidden time starts no scheduled provider work");
  assert.ok(h.peek().nowMs < quote.expires_at_ms!);
  await visible("visible");
  assert.ok(h.peek().nowMs >= quote.expires_at_ms!, "the expired quote is immediately ineligible");
  await h.advance(0);
  assert.equal(h.asked.length, 2, "the overdue quote is refreshed once");
  assert.equal(h.peek().quote, quote, "its numbers remain readable while replacement is pending");
});

test("visibility changes neither duplicate an in-flight quote nor schedule its answer while hidden", async (t) => {
  const visible = pageVisibility(t);
  const h = await harness(t);
  t.after(() => h.close());
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await visible("hidden");
  await h.advance(25_000);
  await visible("visible");
  await h.advance(0);
  assert.equal(h.asked.length, 1, "the existing request retains ownership");
  await visible("hidden");
  await h.answer();
  await h.advance(25_000);
  assert.equal(h.asked.length, 1, "an answer landing while hidden starts no re-ask");
  await visible("visible");
  await h.advance(0);
  assert.equal(h.asked.length, 2);
});

test("a trade keeps its quote held across hidden expiry and visible return", async (t) => {
  const visible = pageVisibility(t);
  const h = await harness(t);
  t.after(() => h.close());
  const props = { request: sell("1000"), viewer: "kai" };
  await h.show(props);
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.answer();
  await h.show({ ...props, held: true });
  await visible("hidden");
  await h.advance(25_000);
  await visible("visible");
  await h.advance(0);
  assert.equal(h.asked.length, 1, "visibility does not release the trade's hold");
  await h.show(props);
  await h.advance(0);
  assert.equal(h.asked.length, 2, "releasing the hold refreshes the overdue quote");
});

test("Retry-After keeps its elapsed deadline across hide and resume", async (t) => {
  const visible = pageVisibility(t);
  const h = await harness(t);
  t.after(() => h.close());
  h.answerAtOnce({ status: "refused", code: "rate_limited", retryAfterSeconds: 10 });
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.advance(2_000);
  await visible("hidden");
  await h.advance(3_000);
  await visible("visible");
  await h.advance(4_999);
  assert.equal(h.asked.length, 1, "returning cannot bypass the refusal's remaining wait");
  await h.advance(1);
  assert.equal(h.asked.length, 2, "the refusal delay is not restarted on return");
  await visible("hidden");
  await h.advance(15_000);
  assert.equal(h.asked.length, 2);
  await visible("visible");
  await h.advance(0);
  assert.equal(h.asked.length, 3, "an already elapsed refusal is retried once");
});

test("manual refresh remains available while hidden", async (t) => {
  const visible = pageVisibility(t);
  const h = await harness(t);
  t.after(() => h.close());
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.answer();
  await visible("hidden");
  await act(async () => h.peek().refresh());
  await flush();
  assert.equal(h.asked.length, 2, "only scheduled work is paused");
});

test("changing request and viewer while hidden preserves the initial read and quote identity", async (t) => {
  const visible = pageVisibility(t);
  const h = await harness(t);
  t.after(() => h.close());
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.answer();
  await visible("hidden");
  await h.show({ request: sell("2000"), viewer: "mira" });
  assert.equal(h.peek().quote, null, "the previous viewer's quote is not actionable");
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  assert.equal(h.asked.length, 2, "a new question still uses its existing debounce");
  assert.equal(h.asked[1]!.amount_in, "2000");
  await h.answer();
  await visible("visible");
  await h.advance(0);
  assert.equal(h.asked.length, 2, "return does not ask the new fresh question twice");
});

test("unmount removes the visibility listener and every owned quote timer", async (t) => {
  const visible = pageVisibility(t);
  const h = await harness(t);
  const listeners = dom.document.listeners.count();
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.answer();
  await visible("hidden");
  await h.close();
  assert.equal(dom.document.listeners.count(), listeners);
  assert.equal(h.timers.size, 0);
  await visible("visible");
  await h.advance(30_000);
  assert.equal(h.asked.length, 1);
});

test("an already queued quote refresh checks visibility even before visibilitychange is dispatched", async (t) => {
  let visibility: DocumentVisibilityState = "visible";
  t.mock.getter(dom.document, "visibilityState", () => visibility);
  const h = await harness(t);
  t.after(() => h.close());
  await h.show({ request: sell("1000"), viewer: "kai" });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  await h.answer();
  const reaskAt = h.peek().quote!.expires_at_ms! - 2_000;
  const reask = [...h.timers.entries()].find(([, timer]) => timer.at === reaskAt)!;
  h.timers.delete(reask[0]);
  visibility = "hidden";
  await act(async () => reask[1].run());
  await flush();
  assert.equal(h.asked.length, 1, "a queued callback cannot start hidden provider work");
});

test("presets read ahead: each is asked once at once, a tap on one is served from its answer, and a held surface reads none", async (t) => {
  const h = await harness(t);
  const presets = [sell("250"), sell("500")];
  await h.show({ request: null, viewer: "kai", prefetch: presets });
  assert.deepEqual(h.asked, presets, "both presets asked without waiting for the pause");
  await h.answer();
  await h.answer();
  await h.show({ request: sell("1"), viewer: "kai", prefetch: presets });
  assert.equal(h.asked.length, 2, "the same presets on the next render ask nothing more");
  await h.show({ request: sell("500"), viewer: "kai", prefetch: presets });
  await h.advance(TRADE_QUOTE_DEBOUNCE_MS);
  assert.equal(h.asked.length, 2, "the tapped preset is its read-ahead answer");
  assert.equal(h.peek().quote?.amount_in, "500");
  await h.show({ request: sell("500"), viewer: "kai", held: true, prefetch: [sell("750")] });
  assert.equal(h.asked.length, 2, "a running trade reads nothing ahead");
  await h.close();
});
