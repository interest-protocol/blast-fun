import assert from "node:assert/strict";
import test from "node:test";
import { BLAST_V1_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { SOCIAL_TRADE_QUOTE_PATH, type SocialTradeQuoteRequest } from "@blast/core/modules/social/contracts/trades.ts";
import { SOCIAL_WALLET_PATH } from "@blast/core/modules/social/contracts/coins.ts";
import { createTestQueryClient, settleQueries, withQueryClient } from "#web/lib/query/test-client.ts";
import { installTestDom, recordAnimations, setInputValue, testEvent, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import { DEFAULT_SWAP_MODE, FIXTURE_COINS, FIXTURE_WALLET_ADDRESS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { fixtureQuote } from "../../../../test/fixtures/social/coins/swap-fixture.ts";
import { tradableCoinView } from "../coins/swap-model.ts";

test("closing mobile V1 Trade discards the pending quote and retains the draft", async (t) => {
  const { document, window } = installTestDom();
  Object.assign(document, { oninput: null });
  const matchMedia = (media: string) => ({ media, matches: media.includes("max-width: 760px"), addEventListener() {}, removeEventListener() {} });
  Object.assign(window, { matchMedia });
  Object.assign(globalThis, { matchMedia });
  const animations = recordAnimations();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LegacyCoinScreen } = await import("./BondingCoinScreen.tsx");
  const { GraduatedCoinTrade } = await import("#web/components/launchpad/trade/CoinTrade.tsx");
  const { SocialViewerProvider } = await import("../SignInGate.tsx");
  const { FeedOverlaysProvider } = await import("../feed-ui/shell-bridge.tsx");
  const coin = BLAST_V1_COINS[0];
  const out = { coin_type: coin.coinType, symbol: coin.symbol, name: coin.name, decimals: coin.decimals, usd_price: "0.01", icon_url: null, presale_id: null };
  const usdc = FIXTURE_COINS[0]!;
  const wallet = { address: FIXTURE_WALLET_ADDRESS, signer: "wallet", fee: "sponsored", as_of_ms: Date.now(),
    coins: [{ coin_type: usdc.coinType, symbol: usdc.symbol, name: usdc.name, decimals: usdc.decimals, atoms: usdc.atoms.toString(), usd_price: "1", value_usd: "860.00", icon_url: null, presale: null }] };
  const quotes = [usdc, tradableCoinView(out)];
  const pending = Promise.withResolvers<void>();
  let held: RequestInit | undefined;
  let holdNext = false;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input), window.location.origin);
    if (pathname === SOCIAL_WALLET_PATH) return Response.json(wallet);
    if (pathname !== SOCIAL_TRADE_QUOTE_PATH) return Response.json({}, { status: 404 });
    const request = JSON.parse(String(init?.body)) as SocialTradeQuoteRequest;
    const quote = fixtureQuote(request, quotes, DEFAULT_SWAP_MODE, Date.now());
    if (holdNext && !held) {
      held = init;
      await pending.promise;
    }
    return Response.json({ ...quote, quote_id: "q1.fixture-mobile-quote" });
  });
  const send = t.mock.fn(async () => ({ status: "traded" as const, title: "Traded" }));
  const client = createTestQueryClient();
  const container = document.createElement("div");
  container.dataset.blastUi = "";
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

  await act(async () => root.render(withQueryClient(client,
    <SocialViewerProvider signedIn callsign="fixture">
      <FeedOverlaysProvider value={{ tradeKit: { signedIn: true, signIn: () => {}, quote: async () => ({ status: "error" }), wallet: async () => null, send } }}>
        <LegacyCoinScreen {...coin} chart={null}
          trade={<GraduatedCoinTrade {...coin} iconUrl={coin.logoUrl} />} />
      </FeedOverlaysProvider>
    </SocialViewerProvider>,
  )));
  const dialog = () => document.querySelector('[role="dialog"]');
  const open = async () => {
    const button = [...container.querySelectorAll("button")].find((each) => each.textContent === "Trade");
    assert.ok(button);
    await act(async () => button.click());
    await act(async () => animations.finishAll());
  };
  assert.equal(dialog(), null);
  await open();
  const input = dialog()?.querySelector("input");
  assert.ok(input);
  await act(async () => {
    setInputValue(input, "100");
    input.dispatchEvent(testEvent("input"));
  });
  const buy = await waitFor(() => {
    const button = dialog()?.querySelector<HTMLButtonElement>("[data-trade]");
    return button && !button.disabled && button;
  }, "Buy enabled after an estimate", 3_000);
  holdNext = true;
  await act(async () => buy.click());
  await waitFor(() => held, "the sealed quote request", 2_000);
  const close = dialog()?.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  assert.ok(close);
  await act(async () => close.click());
  await act(async () => animations.finishAll());
  assert.equal(dialog(), null);

  await act(async () => { pending.resolve(); await settleQueries(client); });
  assert.equal(send.mock.callCount(), 0, "the late quote must not reach signing");
  assert.equal(held?.signal?.aborted, true, "the executable quote request is cancelled");
  await open();
  assert.equal(dialog()?.querySelector("input")?.value, "100");
});
