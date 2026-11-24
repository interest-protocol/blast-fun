import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import { fixtureTradeQuote, fixtureWallet, fixtureCoinType, FIXTURE_USDC } from "../../../../test/fixtures/social/trade/trade-fixtures.ts";
import type { TradeKit } from "./trade-kit";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { SocialViewerProvider } = await import("../SignInGate");
const { useTradeHost } = await import("./TradeHost");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const router = { bfcacheId: "test", push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {}, hmrRefresh() {} };

test("the shell shares an already submitted quote across panel remounts and publishes its outcome once", async (t) => {
  const quote = fixtureTradeQuote({ side: "buy", in_coin: FIXTURE_USDC, out_coin: fixtureCoinType("KSTL"), amount_in: "100000000" }, { signedIn: true, nowMs: Date.now(), wallet: fixtureWallet("wallet") });
  const pending = Promise.withResolvers<Response>();
  let creates = 0;
  let refuse = false;
  let moved = 0;
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === "/api/social/me/wallet?identity=1") return Response.json({ ...fixtureWallet("wallet"), coins: null });
    if (String(url) === "/api/social/trades" && init?.method === "POST") { creates++; return refuse ? Response.json({ error: { code: "price_moved" } }, { status: 400 }) : (await pending.promise).clone(); }
    return Response.json({});
  });
  const client = createTestQueryClient();
  let kit: TradeKit;
  function Host({ panel }: { panel: boolean }) {
    kit = useTradeHost({ balances: { version: 0, changed() { moved++; } } }).tradeKit;
    return panel ? <p>Mounted originating panel</p> : null;
  }
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container);
  const render = (panel: boolean) => root.render(withQueryClient(client, <AppRouterContext value={router}><SocialViewerProvider signedIn callsign="kai"><Host panel={panel} /></SocialViewerProvider></AppRouterContext>));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });
  await act(async () => render(true));
  const input = { quote, coins: { in: { symbol: "USDC", decimals: 6 }, out: { symbol: "KSTL", decimals: 9 } } };
  let first: ReturnType<TradeKit["send"]>;
  let second: ReturnType<TradeKit["send"]>;
  await act(async () => { first = kit!.send(input); await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => render(false));
  await act(async () => render(true));
  await act(async () => { second = kit!.send(input); await new Promise((r) => setTimeout(r, 0)); });
  const observedCreates = creates;
  pending.resolve(Response.json({ trade_id: "00000000-0000-4000-8000-000000000015", status: "confirmed", side: quote.side, in_coin: quote.in_coin, out_coin: quote.out_coin, amount_in: quote.amount_in, amount_out: quote.amount_out, min_out: quote.min_out, amount_out_filled: quote.amount_out, route_label: quote.route_label, network_fee: quote.network_fee && { payer: quote.network_fee.payer, label: quote.network_fee.label }, reservation_id: null, transaction_bytes: null, digest: null, expires_at_ms: null, failure_code: null, created_at_ms: Date.now(), settled_at_ms: Date.now() }));
  await act(async () => { await Promise.allSettled([first!, second!]); });
  assert.equal(observedCreates, 1, "reopening cannot start the quote again while its shell owner is running");
  assert.equal(moved, 1, "the shared outcome invalidates balances once");
  await kit!.send(input);
  assert.equal(creates, 1, "a completed quote cannot be re-armed by a fresh panel");
  await kit!.send({ ...input, quote: { ...quote, quote_id: "new-explicit-quote" } });
  assert.equal(creates, 2, "a new explicit transaction with a new quote is independent");
  refuse = true;
  const retry = { ...input, quote: { ...quote, quote_id: "refused-quote" } };
  assert.equal((await kit!.send(retry)).status, "refused");
  assert.equal((await kit!.send(retry)).status, "refused");
  assert.equal(creates, 4, "a true refusal permits a later explicit retry");
});
