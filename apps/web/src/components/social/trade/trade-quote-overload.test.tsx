import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ReactNode } from "react";

import type { SocialTradeQuoteRequest } from "@blast/core/modules/social/contracts/trades.ts";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

/** Quote overload recovery keeps the server minimum and spreads retries per answer. */

const dom = installTestDom();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { SocialViewerProvider } = await import("../SignInGate");
const { fixtureCoinType, fixtureTradeQuote, fixtureWallet, FIXTURE_USDC } = await import("../../../../test/fixtures/social/trade/trade-fixtures.ts");
const { tradeQuoteDueInMs, DEFAULT_TRADE_QUOTE_POLICY } = await import("./trade-quotes");
type TradeQuoteAnswer = import("./trade-quotes").TradeQuoteAnswer;
const { useTradeQuoteQuery } = await import("./trade-quote-query");
type TradeQuoteState = import("./trade-quote-query").TradeQuoteState;

const KSTL = fixtureCoinType("KSTL");
const sell = (atoms: string): SocialTradeQuoteRequest => ({ in_coin: KSTL, out_coin: FIXTURE_USDC, side: "sell", amount_in: atoms });

const flush = async () => {
  for (let i = 0; i < 3; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
};

type Props = Readonly<{ request: SocialTradeQuoteRequest | null; viewer: string | null; held?: boolean; now?: boolean }>;

async function harness(t: TestContext, client = createTestQueryClient({ queries: { gcTime: 60_000, retryDelay: 0 } })) {
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
    latest = useTradeQuoteQuery({ read, request: props.request, held: props.held === true, now: props.now === true, timers: clock });
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

const busy = (retryAfterSeconds: number | null = 5): TradeQuoteAnswer => ({ status: "refused", code: "quote_busy", retryAfterSeconds, httpStatus: 503 });

function visibilityControl(t: TestContext) {
  let visibility: DocumentVisibilityState = "visible";
  t.mock.getter(dom.document, "visibilityState", () => visibility);
  return async (next: DocumentVisibilityState) => {
    visibility = next;
    await act(async () => dom.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    await flush();
  };
}

test("quote_busy always recovers by default using a positive finite header or the shared five second fallback", () => {
  for (const [seconds, expected] of [[null, 5_000], [0, 5_000], [-1, 5_000], [Number.NaN, 5_000], [Number.POSITIVE_INFINITY, 5_000], [9, 9_000]] as const) {
    assert.equal(tradeQuoteDueInMs({ quote: null, failure: { code: "quote_busy", retryAfterSeconds: seconds } }, 0, DEFAULT_TRADE_QUOTE_POLICY), expected);
  }
});

test("an outage is asked again on its own after its Retry-After or five seconds; other failures wait for a new question", () => {
  const due = (code: string | null, retryAfterSeconds: number | null) => tradeQuoteDueInMs({ quote: null, failure: { code, retryAfterSeconds } }, 0, DEFAULT_TRADE_QUOTE_POLICY);
  assert.equal(due("service_unavailable", null), 5_000);
  assert.equal(due("service_unavailable", 8), 8_000);
  assert.equal(due("invalid_request", null), null);
});

test("an overload answer samples one additive jitter and preserves its deadline across rerenders, hidden tabs and held trades", async (t) => {
  const visible = visibilityControl(t);
  const h = await harness(t);
  // Finish React’s first-render setup before observing quote retry randomness.
  await h.show({ request: null, viewer: "kai", now: true });
  const random = t.mock.method(Math, "random", () => 0.5);
  t.after(() => h.close());
  const props = { request: sell("1000"), viewer: "kai", now: true };
  h.answerAtOnce(busy());
  await h.show(props);
  assert.equal(h.peek().error?.code, "quote_busy");
  assert.equal(h.peek().error?.retryAfterSeconds, 5, "diagnostics retain the server minimum");
  const sampled = random.mock.callCount();
  assert.equal(sampled, 1, "one sample for this actual overload answer");
  await h.advance(1_000);
  await h.show({ ...props, held: true });
  await visible("hidden");
  await h.advance(2_000);
  await h.show({ ...props, held: false });
  await visible("visible");
  await h.show(props);
  await h.advance(2_499);
  assert.equal(h.asked.length, 1, "no request before the original 5.5 second deadline");
  assert.equal(random.mock.callCount(), sampled, "visibility and renders never resample");
  h.answerAtOnce(null);
  await h.advance(1);
  assert.equal(h.asked.length, 2);
  assert.equal(random.mock.callCount(), sampled, "an in-flight retry creates no new error sample");
});

test("the server minimum is never shortened and each successive overload answer gets its own jitter", async (t) => {
  const h = await harness(t);
  const random = t.mock.method(Math, "random", () => 0.75);
  t.after(() => h.close());
  h.answerAtOnce(busy(9));
  await h.show({ request: sell("1000"), viewer: "kai", now: true });
  const firstError = h.client.getQueryCache().getAll()[0]!.state.error;
  await h.advance(9_749);
  assert.equal(h.asked.length, 1);
  await h.advance(1);
  assert.equal(h.asked.length, 2);
  assert.notEqual(h.client.getQueryCache().getAll()[0]!.state.error, firstError, "a new response owns a new error and jitter");
  assert.equal(random.mock.callCount(), 2, "one sample for each actual overload answer");
  await h.advance(9_749);
  assert.equal(h.asked.length, 2, "the next response owns its own deadline");
  h.answerAtOnce(null);
  await h.advance(1);
  assert.equal(h.asked.length, 3);
});

test("a viewer change at the same error timestamp owns a new jitter and timer", async (t) => {
  let sample = 0.1;
  const h = await harness(t);
  const random = t.mock.method(Math, "random", () => sample);
  t.after(() => h.close());
  h.answerAtOnce(busy());
  await h.show({ request: sell("1000"), viewer: "kai", now: true });
  const firstQuery = h.client.getQueryCache().getAll()[0]!;
  sample = 0.9;
  await h.show({ request: sell("1000"), viewer: "mira", now: true });
  assert.equal(h.asked.length, 2);
  const secondQuery = h.client.getQueryCache().getAll()[1]!;
  assert.notEqual(secondQuery.state.error, firstQuery.state.error);
  assert.equal(random.mock.callCount(), 2, "each viewer’s own error samples once");
  assert.equal(secondQuery.state.errorUpdatedAt, firstQuery.state.errorUpdatedAt, "the error object and full viewer key distinguish equal timestamps");
  await h.advance(5_899);
  assert.equal(h.asked.length, 2, "Kai's earlier deadline cannot retry Mira's quote");
  h.answerAtOnce(null);
  await h.advance(1);
  assert.equal(h.asked.length, 3);
});
