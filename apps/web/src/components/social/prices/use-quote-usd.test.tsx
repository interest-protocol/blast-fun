import assert from "node:assert/strict";
import test from "node:test";
import type { MarketStreamListener } from "#web/components/launchpad/market-stream-hub.ts";
import { installTestDom, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import { CREATE_SUI_QUOTE_TYPE } from "@blast/core/web/contracts/create.ts";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";

installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MarketStreamHub } = await import("#web/components/launchpad/market-stream-hub.ts");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { priceQuery } = await import("./price-client.ts");
const { useQuoteUsd } = await import("./use-quote-usd.ts");

function Rate({ id }: Readonly<{ id: string }>) {
  return <output id={id}>{useQuoteUsd(CREATE_SUI_QUOTE_TYPE, { live: true }) ?? "none"}</output>;
}

// This fails if each reader opens its own stream subscription, a reader leaving stops the others' rate, or the
// 60 s read keeps polling while the stream has a fresh rate.
test("two readers share one stream subscription, the last one out stops it, and the read rests on a streamed rate", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { value: class {}, configurable: true, writable: true });
  const listeners: MarketStreamListener[] = [];
  let stops = 0;
  t.mock.method(MarketStreamHub.prototype, "subscribe", ({ listener }: { listener: MarketStreamListener }) => {
    listeners.push(listener);
    return { state: () => "live", ready: () => true, stop: () => { stops += 1; } };
  });
  const client = createTestQueryClient({ queries: { gcTime: Infinity } });
  const { queryKey } = priceQuery({ kind: "coin", id: CREATE_SUI_QUOTE_TYPE, window: "1h" });
  client.setQueryData<SocialPriceHistory | null>(queryKey, () => ({
    presale_id: null, coin_type: CREATE_SUI_QUOTE_TYPE, tier: "5m", from_ms: 0, points: [],
    price_usd: "2", price_as_of_ms: Date.now(), price_24h_usd: null,
    change_24h_bps: null, day_open_usd: null, day_open_ms: null,
  }));
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
  const view = (ids: readonly string[]) => act(async () => root.render(
    <QueryProvider client={client}>{ids.map((id) => <Rate key={id} id={id} />)}</QueryProvider>,
  ));
  const rates = () => [...container.querySelectorAll("output")].map((each) => each.textContent);
  const query = () => client.getQueryCache().find({ queryKey })!;

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
  assert.equal(stops, 0, "a reader leaving keeps the other's subscription");
  await view([]);
  assert.equal(stops, 1, "the last reader leaving stops it");
});
