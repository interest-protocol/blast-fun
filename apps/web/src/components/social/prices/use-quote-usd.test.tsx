import assert from "node:assert/strict";
import test from "node:test";
import type { MarketStreamListener } from "#web/components/launchpad/market-stream-hub.ts";
import { installTestDom, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import { CREATE_QUOTE_TYPE, CREATE_SUI_QUOTE_TYPE } from "@blast/core/web/contracts/create.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/web/contracts/portfolio.ts";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";

installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MarketStreamHub } = await import("#web/components/launchpad/market-stream-hub.ts");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { priceQuery } = await import("./price-client.ts");
const { useQuoteUsd, useQuoteUsdState } = await import("./use-quote-usd.ts");
const { CoinPriceCurrencyProvider, useCoinPriceCurrency } = await import("#web/components/launchpad/chart/CoinPriceCurrency.tsx");

function Rate({ id, coin = CREATE_SUI_QUOTE_TYPE }: Readonly<{ id: string; coin?: string }>) {
  return <output id={id}>{useQuoteUsd(coin, { live: true }) ?? "none"}</output>;
}

type Harness = Readonly<{
  listeners: MarketStreamListener[];
  stops: () => number;
  client: ReturnType<typeof createTestQueryClient>;
  container: HTMLElement;
  root: ReturnType<typeof createRoot>;
}>;

function harness(t: test.TestContext): Harness {
  const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { value: class {}, configurable: true, writable: true });
  const listeners: MarketStreamListener[] = [];
  let stops = 0;
  t.mock.method(MarketStreamHub.prototype, "subscribe", ({ listener }: { listener: MarketStreamListener }) => {
    listeners.push(listener);
    return { state: () => "live", ready: () => true, stop: () => { stops += 1; } };
  });
  const client = createTestQueryClient({ queries: { gcTime: Infinity } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (original) Object.defineProperty(globalThis, "WebSocket", original);
    else Reflect.deleteProperty(globalThis, "WebSocket");
    client.clear();
  });
  return { listeners, stops: () => stops, client, container, root };
}

function seedRead(client: Harness["client"], coin: string, usd: string | null) {
  const { queryKey } = priceQuery({ kind: "coin", id: coin, window: "1h" });
  client.setQueryData<SocialPriceHistory | null>(queryKey, () => ({
    presale_id: null, coin_type: coin, tier: "5m", from_ms: 0, points: [],
    price_usd: usd, price_as_of_ms: Date.now(), price_24h_usd: null,
    change_24h_bps: null, day_open_usd: null, day_open_ms: null,
  }));
  return () => client.getQueryCache().find({ queryKey })!;
}

// This fails if each reader opens its own stream subscription, a reader leaving stops the others' rate, or the
// 60 s read keeps polling while the stream has a fresh rate.
test("two readers share one stream subscription, the last one out stops it, and the read rests on a streamed rate", async (t) => {
  const { listeners, stops, client, container, root } = harness(t);
  const query = seedRead(client, CREATE_SUI_QUOTE_TYPE, "2");
  const view = (ids: readonly string[]) => act(async () => root.render(
    <QueryProvider client={client}>{ids.map((id) => <Rate key={id} id={id} />)}</QueryProvider>,
  ));
  const rates = () => [...container.querySelectorAll("output")].map((each) => each.textContent);

  await view(["a", "b"]);
  assert.equal(listeners.length, 1, "one subscription for both readers");
  assert.deepEqual(rates(), ["2", "2"], "the 60 s read stands in before the stream's first price");
  assert.equal(query().isDisabled(), false);

  await act(async () => {
    listeners[0]!.state("live");
    listeners[0]!.prices?.({ checkpoint: 1, prices: [{ coin_type: CREATE_SUI_QUOTE_TYPE, usd_price: "3.42", as_of_ms: Date.now() }] });
  });
  await waitFor(() => rates().every((rate) => rate === "3.42"), "the streamed rate", 5_000);
  assert.equal(query().isDisabled(), true, "the read rests while the stream has a rate");

  await view(["a"]);
  assert.equal(stops(), 0, "a reader leaving keeps the other's subscription");
  await view([]);
  assert.equal(stops(), 1, "the last reader leaving stops it");
});

// This fails if an expired streamed USDC rate drops to par while the read has a price, or the read stays off.
test("USDC on a live page reads before the stream, follows the stream, and returns to the read when the rate ages out", async (t) => {
  const { listeners, client, container, root } = harness(t);
  const query = seedRead(client, CREATE_QUOTE_TYPE, "0.999");
  const rate = () => container.querySelector("output")?.textContent;
  await act(async () => root.render(<QueryProvider client={client}><Rate id="usdc" coin={CREATE_QUOTE_TYPE} /></QueryProvider>));
  assert.equal(rate(), "0.999", "the read stands in before the stream's first price");

  await act(async () => {
    listeners[0]!.state("live");
    listeners[0]!.prices?.({ checkpoint: 1, prices: [{ coin_type: CREATE_QUOTE_TYPE, usd_price: "1.0002", as_of_ms: Date.now() - PORTFOLIO_PRICE_MAX_AGE_MS + 100 }] });
  });
  await waitFor(() => rate() === "1.0002", "the streamed rate", 5_000);
  assert.equal(query().isDisabled(), true, "the read rests while the stream has a fresh rate");

  await waitFor(() => rate() === "0.999", "the read after the streamed rate ages out", 5_000);
  assert.equal(query().isDisabled(), false, "the read runs once the stream has no fresh rate");
});

// This fails if an expired streamed SUI rate drops to no rate while the read has no price yet.
test("SUI on a live page keeps its last streamed rate when it ages out and the read has no price", async (t) => {
  const { listeners, client, container, root } = harness(t);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const query = seedRead(client, CREATE_SUI_QUOTE_TYPE, null);
  const rate = () => container.querySelector("output")?.textContent;
  await act(async () => root.render(<QueryProvider client={client}><Rate id="sui" /></QueryProvider>));
  assert.equal(rate(), "none", "no rate before the stream's first price");

  await act(async () => {
    listeners[0]!.state("live");
    listeners[0]!.prices?.({ checkpoint: 1, prices: [{ coin_type: CREATE_SUI_QUOTE_TYPE, usd_price: "3.42", as_of_ms: Date.now() - PORTFOLIO_PRICE_MAX_AGE_MS + 100 }] });
  });
  await waitFor(() => rate() === "3.42", "the streamed rate", 5_000);
  await waitFor(() => query().isDisabled() === false, "the read runs once the streamed rate ages out", 5_000);
  assert.equal(rate(), "3.42", "the last streamed rate stands in");
});

function RateState() {
  const { rate, pending } = useQuoteUsdState(CREATE_SUI_QUOTE_TYPE, { live: true });
  return <output>{`${rate ?? "none"} ${pending ? "pending" : "settled"}`}</output>;
}

function PageUnit() {
  const page = useCoinPriceCurrency();
  return <data>{`${page?.unit} ${page?.pending ? "pending" : "settled"}`}</data>;
}

// This fails if a page shows its quote coin before the first rate read answers (the SUI-then-USD flip),
// or if a failed read leaves the page pending instead of falling back to the quote coin.
test("the rate is pending until the first read answers, and a failed read ends it with no rate", async (t) => {
  const { client, container, root } = harness(t);
  let fail: (error: Error) => void = () => {};
  t.mock.method(globalThis, "fetch", () => new Promise((_, reject) => { fail = reject; }));
  const shown = () => container.querySelector("output")?.textContent;
  const unit = () => container.querySelector("data")?.textContent;
  await act(async () => root.render(<QueryProvider client={client}>
    <RateState />
    <CoinPriceCurrencyProvider quoteType={CREATE_SUI_QUOTE_TYPE} quoteSymbol="SUI"><PageUnit /></CoinPriceCurrencyProvider>
  </QueryProvider>));
  assert.equal(shown(), "none pending", "the first read is out");
  assert.equal(unit(), "USD pending", "the page holds its dollar view, never the quote coin first");

  await act(async () => fail(new Error("offline")));
  await waitFor(() => shown() === "none settled", "the failed read ends the pending state", 5_000);
  assert.equal(unit(), "SUI settled", "with no rate the page falls back to the quote coin");
});
