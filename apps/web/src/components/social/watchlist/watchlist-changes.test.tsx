import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { SocialPriceHistory } from "@blast/core/modules/social/contracts/prices.ts";

import { installTestDom, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import type { WatchlistRow } from "./watchlist-model";
installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { WatchlistCard } = await import("./WatchlistCard.tsx");

const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const coin = (n: number, symbol: string, price: string): WatchlistRow => ({
  presale_id: id(n), name: symbol, symbol, icon_url: "", phase: "trading", start_ms: 0, end_ms: 0, fill_pct: 100, multiple: 4.2, price_usd: price,
});
const price = (n: number, change: number | null): SocialPriceHistory => ({
  presale_id: id(n), coin_type: `0x${n}::c::C`, tier: "5m", from_ms: 0, points: [], price_usd: "1", price_24h_usd: null, change_24h_bps: change, day_open_usd: null, day_open_ms: null,
});
const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };

/** The card for a visitor's given rows, the prices read answered by `answer` (its first call's path recorded). */
async function mount(t: TestContext, answer: () => Promise<Response>) {
  const client = createTestQueryClient();
  const asked: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    asked.push(String(input));
    return answer();
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    globalThis.fetch = originalFetch;
  });
  await act(async () => root.render(<QueryProvider client={client}><AppRouterContext value={router}>
    <WatchlistCard nowMs={0} rows={[coin(1, "CETUS", "0.0951"), coin(2, "NAVX", "0.0412"), coin(3, "QUIET", "0.5")]} />
  </AppRouterContext></QueryProvider>));
  const values = () => [...container.querySelectorAll(".v")].map((cell) => [...cell.children].map((child) => child.className === "text" ? "skeleton" : `${child.className}:${child.textContent}`));
  const waitForPrices = () => waitFor(
    () => values().every((row) => !row.includes("skeleton")),
    "watchlist price rows to leave their loading state",
  );
  return { asked, values, container, waitForPrices };
}

test("the watchlist's coin rows read their 24h change once: a skeleton while it reads, then up, down, or nothing without one", async (t) => {
  let release: (response: Response) => void = () => undefined;
  const { asked, values, container, waitForPrices } = await mount(t, () => new Promise((resolve) => (release = resolve)));
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /^\/api\/social\/prices\?/);
  assert.deepEqual(new URL(asked[0]!, "https://blast.test").searchParams.getAll("presale"), [id(1), id(2), id(3)]);
  assert.deepEqual(values(), [[":$0.0951", "skeleton"], [":$0.0412", "skeleton"], [":$0.5", "skeleton"]]);
  await act(async () => {
    release(Response.json({ window: "24h", clock_ms: 0, prices: [price(1, 571), price(2, -305), price(3, null)], as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 } }));
  });
  await waitForPrices();
  assert.deepEqual(values(), [[":$0.0951", "up:+5.71%"], [":$0.0412", "down:−3.05%"], [":$0.5"]]);
  assert.equal(container.querySelector("a")?.getAttribute("aria-label"), "CETUS, $0.0951, +5.71% today");
  assert.doesNotMatch(container.textContent ?? "", /×|–|—/, "never the multiple or a dash in the change's place");
});

test("a failed prices read leaves each coin row's price alone, with no change line", async (t) => {
  const { values, waitForPrices } = await mount(t, async () => new Response(null, { status: 503 }));
  await waitForPrices();
  assert.deepEqual(values(), [[":$0.0951"], [":$0.0412"], [":$0.5"]]);
});
