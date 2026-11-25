import assert from "node:assert/strict";
import test from "node:test";
import type { CoinTradeListener, MarketTrade } from "#web/components/launchpad/market-stream-hub.ts";
import { installTestDom, recordAnimations, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import { coinScreenFixture } from "../../../../test/fixtures/social/bonding/coin-screen-fixtures.ts";
import { curvePoolSummary, CURVE_POOL_KEY, VENUE_POOL_KEY } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import type { CoinPage } from "@blast/core/modules/launchpad-coin/contracts.ts";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";
import { HIDDEN_AMOUNT } from "@blast/core/web/format.ts";
import { quotePriceType } from "@blast/core/web/contracts/create.ts";

installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MarketStreamHub } = await import("#web/components/launchpad/market-stream-hub.ts");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { priceQuery } = await import("#web/components/social/prices/price-client.ts");
const { useCoinPriceCurrency } = await import("#web/components/launchpad/chart/CoinPriceCurrency.tsx");
const { setShellPref } = await import("#web/components/blast-ui/use-shell-prefs.ts");
const { ChartLastTrade } = await import("#web/components/launchpad/chart/ChartLastTrade.tsx");
const { noteOwnTrade, publishChartPrice, useChartPrice } = await import("#web/components/launchpad/chart/chart-live-price.ts");
const { BondingCoinScreen } = await import("./BondingCoinScreen.tsx");
const { CoinPriceFigure } = await import("./CoinPageParts.tsx");

test("a new trade flashes a price change below display precision", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const animations = recordAnimations();
  await act(async () => root.render(<CoinPriceFigure price="0.00012201" tradeId="1" />));
  assert.equal(container.textContent, "$0.000122");
  assert.equal(container.querySelector("button"), null);
  assert.equal(animations.all.length, 0);
  await act(async () => root.render(<CoinPriceFigure price="0.00012202" tradeId="2" />));
  assert.equal(container.textContent, "$0.000122");
  assert.equal(animations.all.length, 1);
});

function ChartCurrencyProbe() {
  const selection = useCoinPriceCurrency();
  return <output aria-label="Chart currency">{selection?.unit} {selection?.quoteUsd}</output>;
}

test("both coin price consumers show the best known close at once, and after the viewer's trade only one that includes it", async (t) => {
  // Its own launch: the viewer's trades are kept for the tab's lifetime.
  const page = { ...coinScreenFixture("live"), launchId: "own-trade-launch" };
  assert.ok(page.curve.state === "available");
  const curve = page.curve;
  const checkpoint = curve.provenance.checkpoint!;
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = createTestQueryClient();
  t.after(async () => {
    await act(async () => root.unmount());
    publishChartPrice(CURVE_POOL_KEY, null);
    client.clear();
  });

  function LastClose() {
    return <output>{useChartPrice(CURVE_POOL_KEY)?.price ?? "—"}</output>;
  }
  const slots = { activity: null, chart: <LastClose />, discovery: null, execution: null, holders: null, market: null, overview: null, theses: null };
  const render = (at: number) => act(async () => root.render(<QueryProvider client={client}>
    <BondingCoinScreen page={{ ...page, curve: { ...curve, provenance: { ...curve.provenance, checkpoint: at } } }} details={null} slots={slots} />
  </QueryProvider>));
  const publish = (at: number, price: string) => act(async () => publishChartPrice(CURVE_POOL_KEY, {
    provenance: { ...curve.provenance, checkpoint: at }, poolKey: CURVE_POOL_KEY, cursor: null, price,
  }));
  const header = () => container.querySelector('[aria-label="Price chart"]')?.previousElementSibling?.querySelector("strong")?.textContent;
  // The waiting row keeps the last price's space, unseen, so the page below it does not move.
  const held = () => container.querySelector('[aria-label="Price chart"]')?.previousElementSibling?.querySelector('strong[aria-hidden="true"]')?.textContent;
  const values = () => [header(), container.querySelector("output")?.textContent];
  await render(checkpoint);
  // A quiet pool's close can predate the page's read: it is still the price.
  await publish(checkpoint - 5, "1.25");
  const shown = header();
  assert.ok(shown && shown !== "—");
  assert.equal(values()[1], "1.25");
  assert.equal(held(), undefined);
  // A routine page refresh does not hide it.
  await render(checkpoint + 1);
  assert.equal(header(), shown);
  assert.equal(values()[1], "1.25");
  // The viewer's own trade does, until a close includes it.
  await act(async () => noteOwnTrade(page.launchId, checkpoint + 2));
  assert.deepEqual(values(), ["—", "—"]);
  assert.equal(held(), shown);
  await publish(checkpoint + 2, "1.5");
  assert.ok(header() && header() !== "—");
  assert.equal(values()[1], "1.5");
  assert.equal(held(), undefined);
});

test("curve progress advances and a delayed trade or page read cannot undo the buy", async (t) => {
  const page = coinScreenFixture("live");
  assert.ok(page.curve.state === "available");
  const read = page.curve;
  const checkpoint = read.provenance.checkpoint! + 1;
  const client = createTestQueryClient({ queries: { gcTime: Infinity } });
  const ask = { kind: "coin", id: quotePriceType(read.data.launch.quoteType), window: "1h" } as const;
  client.setQueryData<SocialPriceHistory | null>(priceQuery(ask).queryKey, () => ({
    presale_id: null, coin_type: ask.id, tier: "5m", from_ms: 0, points: [],
    price_usd: "2", price_as_of_ms: Date.now(), price_24h_usd: null,
    change_24h_bps: null, day_open_usd: null, day_open_ms: null,
  }));
  const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { value: class {}, configurable: true, writable: true });
  let listener: CoinTradeListener;
  let observing = false;
  t.mock.method(MarketStreamHub.prototype, "observe", (coin: string, subscriber: CoinTradeListener) => {
    assert.equal(coin, read.data.launch.coinType);
    observing = true;
    listener = subscriber;
    subscriber.live(true);
    return () => { observing = false; };
  });
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (original) Object.defineProperty(globalThis, "WebSocket", original);
    else Reflect.deleteProperty(globalThis, "WebSocket");
    client.clear();
  });
  const slots = { activity: null, chart: <><ChartLastTrade /><ChartCurrencyProbe /></>, discovery: null, execution: null, holders: null, market: null, overview: null, theses: null };
  const render = (data: CoinPage) => act(async () => root.render(
    <QueryProvider client={client}>
      <BondingCoinScreen page={data} details={null} slots={slots} />
    </QueryProvider>,
  ));
  const summary = curvePoolSummary("live");
  const after = { ...summary, price: "1", market_cap: "5000000000000", inputs: { ...summary.inputs as object, quote_reserve: "1500000000000" } };
  const send = (position: number, data: unknown, poolKey = CURVE_POOL_KEY, quoteAmount = 1_000_000_000n) => act(async () => listener.trade({
    checkpoint, poolKey, summary: data, trade: { cursor: `${checkpoint}:0:${position}:0`, timestampMs: 1_800_000_000_000, side: "buy", kind: "buy", price: "0.8", quoteAmount } as MarketTrade["trade"],
  }));
  const price = () => container.querySelector('[aria-label="Price chart"]')?.previousElementSibling?.querySelector("strong")?.textContent;
  const figures = () => {
    const card = container.querySelector('[aria-label="Launch progress"]')!;
    return [card.querySelector("b")?.textContent, card.querySelector("strong")?.textContent,
      card.querySelector("progress")?.value, price(), card.querySelector("dd")?.textContent];
  };
  await render({
    ...page,
    curve: { state: "unavailable", reason: "not_ready", provenance: read.provenance },
    fresh: { status: "unavailable", reason: "not_ready" },
  });
  assert.equal(observing, false);
  await render(page);
  const findCurrency = (unit: string) => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Price currency"] button')].find((button) => button.textContent === unit)!;
  const chartCurrency = () => container.querySelector('[aria-label="Chart currency"]')?.textContent?.trim();
  assert.equal(chartCurrency(), "USD 2");
  assert.equal(price(), "—");
  await act(async () => findCurrency("SUI").click());
  assert.equal(chartCurrency(), "SUI");
  assert.equal(price(), "—");
  const baseline = figures();
  const headline = () => container.querySelector('[data-chart-last-trade="headline"]');
  const tradeCue = () => headline()?.querySelector("[data-trade-cue]") ?? null;
  const status = () => headline()?.querySelector('[role="status"]')?.textContent;
  assert.ok(headline(), "the price header reserves space before the first event");
  assert.equal(status(), "");
  assert.equal(tradeCue(), null);
  await send(9, summary);
  await send(10, after);
  assert.deepEqual(figures(), ["1,500SUI", "50%", 50, "—", "$2M"]);
  const firstCue = tradeCue();
  assert.equal(container.querySelector('[aria-label="Price chart"] [data-chart-last-trade]'), null);
  assert.equal(container.querySelectorAll("[data-trade-cue]").length, 1);
  assert.equal(firstCue?.textContent, "Buy · 1\u00a0SUI");
  assert.equal(status(), "New buy");
  await send(9, summary);
  await send(10, summary);
  assert.equal(tradeCue(), firstCue);
  assert.deepEqual(figures(), ["1,500SUI", "50%", 50, "—", "$2M"]);
  // A second equally small buy still gets a new cue when all displayed figures stay the same.
  await send(11, after);
  assert.equal(tradeCue()?.textContent, firstCue.textContent);
  assert.equal(tradeCue(), firstCue, "equal-size trades reuse the headline readout");
  const secondCue = tradeCue();
  await send(11, null);
  await send(12, summary, "another-pool");
  const otherId = "0x" + "aa".repeat(32);
  await send(13, { ...summary, pool_id: otherId, pool_key: `blast_curve:${otherId}` });
  await send(14, curvePoolSummary("migrated"));
  await render({ ...page, curve: { ...read, provenance: { ...read.provenance, checkpoint: null } } });
  assert.deepEqual(figures(), ["1,500SUI", "50%", 50, "—", "$2M"]);
  await render({ ...page });
  assert.deepEqual(figures(), ["1,500SUI", "50%", 50, "—", "$2M"]);
  await render({ ...page, curve: { ...read, provenance: { ...read.provenance, checkpoint } } });
  assert.deepEqual(figures(), baseline);
  assert.equal(tradeCue(), secondCue, "confirming history preserves the observed buy");
  await act(async () => listener.live(false));
  assert.equal(tradeCue(), secondCue, "a disconnected stream keeps the last trade readable");
  assert.ok(container.querySelector("[data-chart-last-trade] time"), "the observed trade time survives a disconnect");
  await render(page);
  assert.notDeepEqual(figures(), baseline);
  const animations = recordAnimations();
  await send(15, summary);
  assert.deepEqual(figures(), baseline, "catch-up updates the summary");
  assert.equal(tradeCue()?.textContent, "Buy · 1\u00a0SUI");
  assert.equal(animations.all.length, 0, "catch-up can change the figures without cueing any of them");
  await act(async () => listener.live(true));
  await send(16, after);
  assert.equal(tradeCue()?.textContent, "Buy · 1\u00a0SUI");
  await render({ ...page, curve: { ...read, provenance: { ...read.provenance, checkpoint: checkpoint + 1 } } });
  assert.deepEqual(figures(), baseline, "a newer authoritative page takes over the figures");
  const whileDelayed = animations.all.length;
  await send(17, after);
  assert.equal(animations.all.length, whileDelayed, "late receipts behind the page stay quiet");
  await render({ ...page, curve: { ...read, provenance: { ...read.provenance, checkpoint: null } } });
  await send(17, summary);
  assert.deepEqual(figures(), baseline, "a rejected stale receipt cannot consume the cursor of a later valid trade");
  await send(18, summary, CURVE_POOL_KEY, 500_000_000_000n);
  assert.equal(tradeCue()?.textContent, "Large buy · 500\u00a0SUI", "the current rate values a 500 SUI buy at $1,000");
  await act(async () => setShellPref("amountsHidden", true));
  assert.equal(tradeCue()?.textContent, `Buy · ${HIDDEN_AMOUNT}`);
  assert.equal(tradeCue()?.hasAttribute("title"), false);
  await act(async () => setShellPref("amountsHidden", false));
  const graduated = coinScreenFixture("migrated");
  const venueCheckpoint = graduated.venue?.provenance?.checkpoint;
  assert.ok(venueCheckpoint != null);
  await render(graduated);
  assert.equal(observing, true, "the graduated card follows the recorded venue");
  assert.equal(tradeCue(), null);
  await send(17, after);
  assert.equal(tradeCue(), null, "the old curve cannot cue a graduated market");
  const headlines = () => {
    const card = container.querySelector('[aria-label="Market overview"]')!;
    const fdvLabel = Array.from(card.querySelectorAll("dt")).find((label) => label.textContent === "FDV");
    return [price(), fdvLabel?.nextElementSibling?.textContent];
  };
  const baselineVenue = headlines();
  const swap = (position: number, side: "buy" | "sell", poolKey: string = VENUE_POOL_KEY, at = checkpoint, price = "0.5", fdvUsd: string | null = "37200") => act(async () => listener.trade({
    poolKey, checkpoint: at, summary: null,
    trade: { cursor: `${at}:0:${position}:0`, timestampMs: 1_800_000_000_000, kind: "swap", side, price, fdvUsd, trader: "0x1", quoteAmount: 1_000_000_000n } as MarketTrade["trade"],
  }));
  await swap(19, "sell", VENUE_POOL_KEY, venueCheckpoint);
  assert.equal(tradeCue(), null, "a swap already covered by the initial venue snapshot stays quiet");
  await swap(20, "sell", "cetus:0x" + "12".repeat(32));
  assert.equal(tradeCue(), null, "an unrelated venue trade stays silent");
  await swap(21, "sell");
  assert.deepEqual(headlines(), ["—", "$37.2K"]);
  await act(async () => findCurrency("USD").click());
  assert.equal(chartCurrency(), "USD 2");
  assert.equal(price(), "—");
  await act(async () => findCurrency("SUI").click());
  const sellCue = tradeCue();
  assert.equal(sellCue?.getAttribute("data-trade-cue"), "sell");
  await swap(21, "sell");
  assert.equal(tradeCue(), sellCue, "a second receipt for the same swap cannot flash twice");
  await swap(22, "buy", VENUE_POOL_KEY, checkpoint, "0.6", "38100");
  assert.deepEqual(headlines(), ["—", "$38.1K"]);
  await swap(21, "sell");
  assert.deepEqual(headlines(), ["—", "$38.1K"], "a late swap in the same checkpoint cannot undo both figures");
  assert.equal(tradeCue()?.getAttribute("data-trade-cue"), "buy");
  await swap(23, "buy", VENUE_POOL_KEY, checkpoint, "0.7", null);
  assert.deepEqual(headlines(), ["—", undefined], "a missing USD rate cannot label an older cap as current");
  assert.ok(graduated.venue);
  await render({ ...graduated, venue: { ...graduated.venue, provenance: { ...graduated.venue.provenance!, checkpoint } } });
  assert.deepEqual(headlines(), baselineVenue, "the complete venue snapshot takes over once it catches up");
  await act(async () => listener.live(false));
  assert.equal(tradeCue()?.textContent, "Buy · 1\u00a0SUI", "the latest venue trade stays readable across the disconnect");
  await act(async () => findCurrency("USD").click());
  await act(async () => {
    client.setQueryData(priceQuery(ask).queryKey, null);
  });
  await waitFor(() => findCurrency("USD").disabled, "USD is unavailable when its rate disappears");
  assert.equal(findCurrency("SUI").getAttribute("aria-pressed"), "true");
  assert.equal(chartCurrency(), "SUI");
  assert.equal(price(), "—");
});
