import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SOCIAL_PRICES_PATH } from "@blast/core/modules/social/contracts/prices.ts";
import { CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/web/contracts/create.ts";
import { CORE_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import type { SocialTradeQuote } from "@blast/core/web/contracts/trades.ts";

import { createTestQueryClient, settleQueries, withQueryClient } from "#web/lib/query/test-client.ts";
import { setInputValue } from "../../../../test/fixtures/social/test-dom.ts";

import { mountSwap, swapDom } from "../../../../test/fixtures/social/coins/coins.test-support.tsx";
import { CoinSheet, type CoinSheetTrading } from "./CoinSheet";
import { PUBLIC_PREFERRED_COINS, type CoinScreen, type WalletCoinView } from "./coin-model";
import { DEFAULT_SWAP_MODE, FIXTURE_WALLET_ADDRESS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { FIXTURE_COINS, FIXTURE_MORE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { fixtureQuote } from "../../../../test/fixtures/social/coins/swap-fixture.ts";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { FINDING_PRICE, PLAIN_SWAP_PAIR } from "./swap-model";
import { TokenPickerBody } from "./TokenPicker";

/**
 * Social feed R3-33: the trade screen's and the picker's markup in each of
 * the ticket's states (the server render; effects do not run, so a state
 * that needs an answer gets one in hand through the fixture's seed).
 */

const [USDC, SUI] = FIXTURE_COINS as [WalletCoinView, WalletCoinView];
const text = (html: string) => html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const button = (html: string) => /<button[^>]*data-trade=""[^>]*>(.*?)<\/button>/.exec(html)![0];

test("Swap can select every zero-balance preferred coin from rows and quick choices", async (t) => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = swapDom.document.createElement("div"); swapDom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const picks: WalletCoinView[] = [];
  await act(async () => root.render(<TokenPickerBody current={PUBLIC_PREFERRED_COINS[0]!} hidden={false}
    listCoins={async () => []} onPick={coin => { picks.push(coin); }} pins={[]} wallet={PUBLIC_PREFERRED_COINS} />));
  for (const coin of PUBLIC_PREFERRED_COINS) {
    const row = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(row => row.querySelector("b")?.textContent === coin.symbol);
    assert.ok(row, `${coin.symbol} remains listed at zero`);
    assert.notEqual(row.getAttribute("aria-disabled"), "true");
    await act(async () => row.click());
    assert.equal(picks.at(-1)?.coinType, coin.coinType);
    assert.equal(picks.at(-1)?.atoms, 0n);
    const chip = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Quick choices"] button')].find(button => button.textContent === coin.symbol);
    assert.ok(chip && !chip.disabled);
    await act(async () => chip.click());
    assert.equal(picks.at(-1)?.coinType, coin.coinType);
    assert.equal(picks.at(-1)?.atoms, 0n);
  }
  assert.equal(picks.length, 6, "each row and chip invokes selection");
});

function trading(extra: Partial<CoinSheetTrading> = {}): CoinSheetTrading {
  return {
    signedIn: true,
    onSignIn: () => undefined,
    requestQuote: () => new Promise(() => undefined),
    listCoins: async () => [],
    trade: async () => ({ status: "traded" }),
    ...extra,
  };
}

test("visitors can find ecosystem coins by ticker, and Swap shows no market panel", async (t) => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = swapDom.document.createElement("div");
  swapDom.document.body.append(container);
  const root = createRoot(container);
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ competitions: [], as_of_ms: Date.now() }));
  await act(async () => root.render(withQueryClient(client, <CoinSheet
    first={{ kind: "trade", key: PLAIN_SWAP_PAIR.in, out: PLAIN_SWAP_PAIR.out }}
    inline open session={1} trading={trading({ signedIn: false })} wallet={{ status: "visitor" }}
    onClose={() => undefined} onCopy={() => undefined} onRetry={() => undefined} onWithdraw={async () => false}
  />)));
  for (const symbol of ["CETUS", "DEEP"]) {
    await act(async () => container.querySelector<HTMLButtonElement>('[data-coin-pick="out"]')!.click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search coins"]')!;
    await act(async () => {
      setInputValue(input, symbol.toLowerCase());
      input.dispatchEvent(new swapDom.window.Event("input", { bubbles: true }));
    });
    const results = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.deepEqual(results.map((row) => row.querySelector("b")?.textContent), [symbol]);
    await act(async () => results[0]!.click());
    assert.match(container.querySelector('[data-coin-pick="out"]')?.textContent ?? "", new RegExp(symbol));
    await act(async () => settleQueries(client));
    assert.equal(container.querySelector('[aria-label="Swap market data"]'), null);
    assert.doesNotMatch(container.textContent ?? "", new RegExp(`${symbol} market`));
  }
  assert.equal(fetch.mock.calls.filter((call) => typeof call.arguments[0] === "string" && call.arguments[0].startsWith(`${SOCIAL_PRICES_PATH}?`)).length, 0, "no market price reads");
});

test("Swap's More coins reaches every curated coin and every server page, and a press never moves a row already shown", async (t) => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = swapDom.document.createElement("div");
  swapDom.document.body.append(container);
  const root = createRoot(container);
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  t.mock.method(globalThis, "fetch", async () => Response.json({ competitions: [], as_of_ms: Date.now() }));
  // Two server pages of Blast coins, as the unsearched trade-coin list pages them.
  const blast = Array.from({ length: 50 }, (_, index) => {
    const symbol = `B${String(index).padStart(2, "0")}`;
    return { ...FIXTURE_MORE_COINS[0]!, key: symbol, symbol, coinType: `0x${index.toString(16).padStart(64, "0")}::coin::${symbol}` };
  });
  const listCoins: CoinSheetTrading["listCoins"] = async (_term, _signal, cursor) => cursor ? { coins: blast.slice(25), nextCursor: null } : { coins: blast.slice(0, 25), nextCursor: "p2" };
  await act(async () => root.render(withQueryClient(client, <CoinSheet
    first={{ kind: "trade", key: PLAIN_SWAP_PAIR.in, out: PLAIN_SWAP_PAIR.out }}
    inline open session={1} trading={trading({ signedIn: false, listCoins })} wallet={{ status: "visitor" }}
    onClose={() => undefined} onCopy={() => undefined} onRetry={() => undefined} onWithdraw={async () => false}
  />)));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-coin-pick="out"]')!.click());
  await act(async () => settleQueries(client));
  const listed = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => row.querySelector("b")?.firstChild?.textContent);
  const more = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Load more supported coins");
  assert.ok(listed().includes("USDsui"), "USDsui shows without a search");
  for (let press = 0; more() && press < 10; press++) {
    const before = listed();
    await act(async () => more()!.click());
    await act(async () => settleQueries(client));
    assert.deepEqual(listed().slice(0, before.length), before, `press ${press + 1} kept the rows already shown in place`);
  }
  assert.equal(more(), undefined);
  const symbols = new Set(listed());
  assert.deepEqual([...CORE_COINS, ...blast].filter((coin) => !symbols.has(coin.symbol)).map((coin) => coin.symbol), []);
  const legacyRows = [...container.querySelectorAll<HTMLElement>('[role="option"]:has([aria-label="Legacy · Blast V1"])')];
  assert.deepEqual(legacyRows.map((row) => row.querySelector("b")?.firstChild?.textContent), ["MANIFEST", "Wheels", "BLAST", "HELMET"]);
  const ourBlastBot = legacyRows.find((row) => row.textContent?.includes("OurBlastBot"));
  assert.ok(ourBlastBot);
  await act(async () => ourBlastBot.click());
  assert.match(container.querySelector('[data-coin-pick="out"]')?.textContent ?? "", /BLAST/);
});

function render(stack: readonly CoinScreen[], extra: Partial<CoinSheetTrading> = {}, fee: "sponsored" | "wallet" = "sponsored") {
  return renderToStaticMarkup(
    <CoinSheet
      first={stack.at(-1)!}
      onClose={() => undefined}
      onCopy={() => undefined}
      onRetry={() => undefined}
      onWithdraw={async () => false}
      open
      session={1}
      trading={trading(extra)}
      wallet={{ status: "ready", address: FIXTURE_WALLET_ADDRESS, fee, coins: FIXTURE_COINS }}
    />,
  );
}

const SUI_TO_USDC: readonly CoinScreen[] = [{ kind: "trade", key: "sui" }];
/** The gate's sample at 100 SUI, in R3-30's shape (the fixture's answer). */
const sample = (signedIn = true, fee: "sponsored" | "wallet" = "sponsored") =>
  fixtureQuote(
    { in_coin: SUI.coinType, out_coin: USDC.coinType, side: "sell", amount_in: "100000000000" },
    FIXTURE_COINS,
    { quote: "ok", trade: "ok", signedIn, fee },
    Date.now(),
  );

test("typing an amount reads a quote, says its cost beside the button, and the detail opens under it", async (t) => {
  const screen = await mountSwap(t, trading({ requestQuote: async () => ({ status: "ok", body: sample(), httpStatus: 200 }) }));
  await screen.type("100"); await screen.settle();
  assert.match(screen.container.textContent!, /341.99/);
  assert.match(screen.trade().textContent!, /^Swap$/);
  assert.equal(screen.trade().disabled, false);
  const detail = screen.container.querySelector<HTMLButtonElement>(".txSum")!;
  await screen.act(async () => detail.click());
  assert.equal(detail.getAttribute("aria-expanded"), "true");
  const cost = document.getElementById(screen.trade().getAttribute("aria-describedby")!)!;
  assert.equal(cost.textContent, "Sell 100\u00a0SUI for at least 340.28\u00a0USDC. Blast fee 0.5%.");
  assert.deepEqual([...cost.querySelectorAll(".ticker")].map((node) => node.textContent), ["SUI", "USDC"], "each ticker takes the shared class");
});

test("a short fee balance is said once, by the money sentence, and the button keeps its verb, off", async (t) => {
  const short = { ...sample(), quote_id: null, offer_refused: "insufficient_balance" as const, balance_failure: { reason: "gas" as const, coin_type: SUI.coinType, required_atoms: "2820419", available_atoms: "0" } };
  const screen = await mountSwap(t, trading({ requestQuote: async () => ({ status: "ok", body: short, httpStatus: 200 }) }));
  await screen.type("100"); await screen.settle();
  assert.equal(screen.trade().textContent, "Swap");
  assert.equal(screen.trade().disabled, true);
  assert.match(screen.container.querySelector('[id$="-cost"]')!.textContent!, /^The network fee needs [\d.]+\u00a0SUI\. You have [\d.]+\u00a0SUI\.$/);
  assert.equal(screen.container.querySelector('[role="alert"]'), null);
});

test("Max enters whole-balance mode and typing clears that mode", async (t) => {
  const screen = await mountSwap(t, trading());
  const max = [...screen.container.querySelectorAll("button")].find((button) => button.textContent === "Max")!;
  await screen.act(async () => max.click());
  assert.equal(screen.container.querySelector("input")!.getAttribute("data-mode"), "whole");
  assert.match(screen.container.textContent!, /Whole balance/);
  // The selected Max chip says it on screen; the words are for screen readers only, through the field's description.
  const mode = screen.container.querySelector(`#${screen.container.querySelector("input")!.getAttribute("aria-describedby")!.split(" ")[1]}`)!;
  assert.equal(mode.textContent, "Whole balance");
  assert.equal(mode.className, "sr");
  // The balance's ticker and the chip's are the shared class, so a long one wraps rather than being cut.
  assert.ok(screen.container.querySelector("[data-coin-pick] .ticker"));
  assert.ok([...screen.container.querySelectorAll("span.ticker")].some((node) => node.parentElement!.textContent!.startsWith("Balance ")));
  await screen.type("412.385");
  assert.equal(screen.container.querySelector("input")!.getAttribute("data-mode"), "typed");
  assert.doesNotMatch(screen.container.textContent!, /Whole balance/);
});

test("a real trade blocks controls while pending and asks approval for an unsponsored fee", async (t) => {
  const pending = Promise.withResolvers<import("./SwapForm").TradeOutcome>();
  let calls = 0;
  const screen = await mountSwap(t, trading({
    requestQuote: async () => ({ status: "ok", body: sample(), httpStatus: 200 }),
    trade: async (ask) => { calls += 1; if (calls === 1) return pending.promise; assert.equal(ask.acceptFee, true); return { status: "failed", message: "Wallet refused", code: null }; },
  }));
  await screen.type("500");
  assert.equal(screen.trade().textContent, "Swap");
  assert.equal(screen.container.querySelector('[id$="-cost"]')!.textContent, "Not enough SUI for this amount.", "the off button's reason is the line above it");
  await screen.type("100"); await screen.settle();
  await screen.press();
  assert.equal(screen.trade().getAttribute("aria-busy"), "true");
  assert.equal(screen.container.querySelector<HTMLInputElement>("input")!.disabled, true);
  await screen.act(async () => pending.resolve({ status: "fee_required", feeMist: "2565136" }));
  assert.equal(screen.trade().textContent, "Swap", "the fee goes in the money sentence; the button keeps its verb");
  assert.match(screen.container.querySelector('[id$="-cost"]')!.textContent!, /Network fee ≈ 0\.00257\u00a0SUI\./);
  await screen.press();
  assert.equal(calls, 2);
  assert.equal(screen.trade().textContent, "Swap");
  assert.match(screen.container.querySelector('[role="alert"]')!.textContent!, /Wallet refused/);
  assert.equal(screen.container.querySelector<HTMLInputElement>("input")!.disabled, false);
});

test("R3-33-AC-7 and AC-9: a wallet session's fee line; a visitor's button signs in", () => {
  const session = render(SUI_TO_USDC, {}, "wallet");
  assert.match(text(session), /Network fee Paid from your SUI/);
  assert.doesNotMatch(text(session), /Paid by Blast|Free/);
  const visitor = render(SUI_TO_USDC, { signedIn: false });
  assert.match(button(visitor), /aria-describedby="[^"]*-cost"/);
  assert.match(text(button(visitor)), /^Sign in$/);
  assert.match(text(visitor), /Sign in to swap\./, "the line above the button gives the short reason; the button keeps its label");
});

test("the empty You get is muted (the Swap board's text3); picker keyboard highlighting also works with a touch screen", () => {
  const css = readFileSync(new URL("./coins.module.css", import.meta.url), "utf8");
  assert.match(css, /\.amtVal\.zero \{ color: var\(--muted\); \}/);
  assert.match(css, /\.tpRow\.kb \{ background: var\(--raised\); \}/, "the gate's `.tp-row.kb` highlight");
  assert.doesNotMatch(css, /@media \(hover: none\) \{ \.tpRow\.kb/);
});

test("R3-33-AC-3: the picker — search, the three preferred chips, Your coins with the current coin ticked", () => {
  const picker = (more: readonly WalletCoinView[] = FIXTURE_MORE_COINS) =>
    renderToStaticMarkup(
      <TokenPickerBody current={USDC} hidden={false} listCoins={async () => more} onPick={() => undefined} pins={[]} wallet={FIXTURE_COINS} />,
    );
  const html = picker();
  assert.match(html, /<input[^>]*role="combobox"[^>]*aria-label="Search coins" maxLength="200" placeholder="Search name, ticker or coin type"/);
  assert.match(html, /<div aria-label="Quick choices" class="tpChips" role="group"><button aria-pressed="false" class="tokChip tpChip" type="button">.*SUI<\/button><button aria-pressed="true" class="tokChip tpChip on" type="button">.*USDC<\/button><button aria-pressed="false" class="tokChip tpChip" type="button">.*USDsui<\/button><\/div>/);
  assert.match(html, /role="listbox"[^>]*aria-label="Coins"/);
  const container = swapDom.document.createElement("div");
  container.innerHTML = html;
  // The route's coins arrive after the first render; held coins are listed at once.
  const rows = [...container.querySelectorAll('[role="option"]')];
  assert.deepEqual(rows.map((row) => [
    row.querySelector(".identityText b")?.textContent,
    row.querySelector(".identityText > span")?.textContent,
    row.querySelector(".v b")?.textContent,
    row.querySelector(".v > span")?.textContent,
  ]), [
    ["SUI", "Sui", "$1,410", "412.38"],
    ["KSTL", "Kestrel", "$1,260", "600,000"],
    ["USDC", "USD Coin", "$860", "860"],
    ["LUMN", "Lumen", "$130", "100,000"],
  ]);
  assert.equal(container.querySelector(".srH")?.textContent, "Your coins");
  for (const row of rows) {
    const symbol = row.querySelector(".identityText b")?.textContent;
    const coin = FIXTURE_COINS.find((entry) => entry.symbol === symbol)!;
    const descriptor = row.querySelector(".pickerIdentity > span:not(.identity)");
    if (symbol === "SUI" || symbol === "USDC") {
      assert.equal(descriptor?.textContent, symbol === "SUI" ? "Sui ecosystem" : "Stablecoin");
    } else {
      assert.equal(descriptor?.textContent, coin.coinType);
      assert.equal(descriptor?.getAttribute("title"), symbol === "KSTL" ? "0x5555…5551::coin::KSTL" : "0x5555…5552::coin::LUMN");
    }
    assert.equal(row.getAttribute("aria-selected"), String(coin.coinType === USDC.coinType));
  }
  assert.equal(container.querySelectorAll(".qtick svg").length, 1);
  assert.equal(container.querySelector('[aria-selected="true"] .qtick svg')?.getAttribute("stroke-width"), "2.6");
});

test("the swap coin list marks the selected coin with a neutral check", () => {
  const css = readFileSync(new URL("./coins.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.qtick \{ flex: none; width: 22px; height: 22px; border-radius: 999px; display: grid; place-items: center; color: var\(--ink\); \}/);
  assert.match(css, /\.qtick svg \{ width: 20px; height: 20px; stroke-width: 2\.6; \}/);
  assert.doesNotMatch(css, /\.qtick[^{]*\{[^}]*background/, "no circle behind the check, chosen or not");
});

test("the dock's Swap opens the trade screen on the plain swap's pair: sell USDC, get SUI (the gate's `bxDrawerCoin('trade')`)", () => {
  const html = render([{ kind: "trade", key: PLAIN_SWAP_PAIR.in, out: PLAIN_SWAP_PAIR.out }]);
  assert.match(text(html), /Pay Balance 860 USDC USDC .*Receive Balance 412\.38 SUI — SUI/);
  assert.match(button(html), />Swap<\/button>$/);
  assert.match(text(html), /Enter an amount\./);
});

test("the picker labels a presale allocation and allows buying it only on the output side", () => {
  const HLCN = FIXTURE_MORE_COINS[0]!;
  const coin: WalletCoinView = { ...HLCN, atoms: 1000000000n, presale: { ...HLCN.presale!, trading: false, inPresale: true, quoteSymbol: "SUI", quoteType: CREATE_SUI_QUOTE_TYPE } };
  const picker = (allowPresales: boolean) => renderToStaticMarkup(<TokenPickerBody current={USDC} wallet={[coin]} pins={[]} hidden={false} listCoins={async () => []} onPick={() => undefined} allowPresales={allowPresales} />);
  const buy = picker(true);
  assert.match(text(buy), /In presale · Pay with SUI/);
  assert.match(text(buy), /Presale/);
  assert.doesNotMatch(text(buy), /swap another coin/);
  assert.doesNotMatch(buy, /aria-disabled="true"/);
  const sell = picker(false);
  assert.match(sell, /aria-disabled="true"/);
  assert.match(text(sell), /Unavailable.*In presale · Selling unavailable/);
  assert.doesNotMatch(text(sell), /Pay with|Buy with/);
});

test("Swap hides TSUI and its known presales from rows and quick choices", () => {
  const tsui = { ...SUI, coinType: CREATE_TEST_SUI_QUOTE_TYPE, key: "tsui", name: "Test Sui", symbol: "TSUI" };
  const testLaunch = { ...tsui, key: "tsui-launch", coinType: "0xbb95f095a7601a3500ee0a6983459a21ed1c91253ea2a2599eeb1e1ead76ef83::tsui::TSUI" };
  const listed = FIXTURE_MORE_COINS[0]!;
  const testSale = { ...listed, name: "Test Sale", symbol: "TSALE", presale: { ...listed.presale!, inPresale: true, quoteType: CREATE_TEST_SUI_QUOTE_TYPE } };
  const html = renderToStaticMarkup(<TokenPickerBody
    allowPresales catalogCoins={[testSale, testLaunch]} current={tsui} hidden={false}
    listCoins={async () => []} onPick={() => undefined} pins={[]}
    quickChoices={[testSale, testLaunch]} wallet={[SUI, tsui]}
  />);
  assert.doesNotMatch(text(html), /TSUI|TSALE/);
  assert.match(text(html), /\bSUI\b/);
});

test("Swap board: the sheet, its boxes, the flip, the presets and the action keep the board's geometry", () => {
  const css = readFileSync(new URL("./coins.module.css", import.meta.url), "utf8");
  assert.match(css, /\.sheet\.sheet:has\(> \.swapDialog\) \{\s*--sheet-px: 20px;\s*width: min\(460px, 100%\);\s*padding: 20px var\(--sheet-px\);\s*border-radius: 26px;\s*\}/);
  assert.match(css, /\.swapDialog \.head h2 \{ font-family: var\(--font\); font-size: 22px; font-weight: 650; letter-spacing: -\.02em; line-height: 1\.3; \}/);
  assert.match(css, /\.swapDialog\.screen \{ gap: 16px; \}/);
  assert.match(css, /\.swapDialog \.tradeBody \{ --trade-gap: 6px; \}/);
  assert.match(css, /\.swapDialog \.amt \{ padding: 16px; gap: 6px; border-radius: 18px; \}/);
  assert.match(css, /\.flipSlot \{[^}]*margin: -15px 0;/);
  assert.match(css, /\.swapFlip \{[^}]*width: 36px; height: 36px; border-radius: 12px; background: var\(--chip\); box-shadow: 0 0 0 4px var\(--card\);/);
  assert.match(css, /\.swapDialog \.presets \{ gap: 6px; margin-top: 8px; \}/);
  assert.match(css, /\.swapDialog \.preset \{ height: 36px; border-radius: var\(--r-button\); font-size: 13px; background: var\(--chip\); box-shadow: none; \}/);
  assert.match(css, /\.swapDialog \[data-trade\] \{ height: 54px; min-height: 54px; border-radius: 15px; font-size: 16px; \}/);
  assert.match(css, /button\.txSum\[data-ui-button\] \{[^}]*color: var\(--muted\); font-size: 13px; font-weight: 500; \}/);
});

test("typing is priced from the browser's route; a press asks the server once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const routed: bigint[] = [];
  let served = 0;
  const screen = await mountSwap(t, trading({
    findRoute: async (request) => {
      routed.push(request.amount);
      const amountOut = request.amount * 3n / 1_000n;
      const path = { poolId: "0x1", provider: "CETUS", direction: true, from: request.from, target: request.target, feeRate: "0.0025", amountIn: request.amount, amountOut, publishedAt: "0x2" };
      return { status: "route", route: { requestId: "r", amountIn: request.amount, amountOut, blastFee: amountOut / 199n, deviationRatio: "0", aggregatorPackage: "0x3", paths: [path] } };
    },
    requestQuote: async (request) => {
      served += 1;
      return { status: "ok", httpStatus: 200, body: fixtureQuote(request, FIXTURE_COINS, DEFAULT_SWAP_MODE, Date.now()) };
    },
  }));
  const tick = async (ms: number) => {
    await screen.act(async () => {
      t.mock.timers.tick(ms);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  };
  await tick(0);
  assert.equal(routed.length, 0, "opening the sheet does not ask for routes");
  await screen.type("100");
  for (const ms of [320, 0, 0]) await tick(ms);
  assert.deepEqual(routed.at(-1), 100_000_000_000n, "the typed amount is routed in the browser");
  assert.equal(served, 0, "no server call while typing");
  assert.equal(screen.trade().disabled, false, "the estimate turns the button on");
  await screen.act(async () => screen.trade().click());
  await tick(0);
  assert.equal(served, 1, "the press seals the quote on the server, once");
  assert.equal(screen.trade().textContent, "Successful");
});

/**
 * A signed-in trade screen on a mocked clock whose quotes live `lifetimeMs` and each carry a new id (`q1.fresh-N`,
 * as the server's are). `answer(n)` releases quote request n (1-based); each trade's quote id is recorded.
 */
async function freshQuoteSwap(t: import("node:test").TestContext, estimate?: Partial<SocialTradeQuote>) {
  // A real-looking clock: the query cache reads a zero `dataUpdatedAt` as "never answered".
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const asked: ((changes?: Partial<SocialTradeQuote>) => void)[] = [];
  const sent: string[] = [];
  let release: ((outcome: { status: "traded" }) => void) | null = null;
  const holdTrade = { on: false };
  const screen = await mountSwap(t, trading({
    requestQuote: (request) => new Promise((resolve) => {
      const n = asked.length + 1;
      asked.push((changes) => {
        const body = fixtureQuote(request, FIXTURE_COINS, DEFAULT_SWAP_MODE, Date.now());
        resolve({ status: "ok", httpStatus: 200, body: { ...body, quote_id: `q1.fresh-${n}`, expires_at_ms: Date.now() + 20_000, ...changes } });
      });
    }),
    trade: (ask) => {
      sent.push(ask.quote.quote_id!);
      return holdTrade.on ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ status: "traded" });
    },
  }));
  const tick = async (ms: number) => {
    await screen.act(async () => {
      t.mock.timers.tick(ms);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  };
  const answer = async (n: number, changes?: Partial<SocialTradeQuote>) => { await screen.act(async () => { asked[n - 1]!(changes); await new Promise<void>((resolve) => setImmediate(resolve)); }); await tick(0); };
  await screen.type("100");
  await tick(320);
  await answer(1, estimate);
  assert.equal(screen.trade().disabled, false, "the first quote is offered");
  /** A real press: focus lands on the button, then the click (jsdom does not focus on click). */
  const click = async () => { await screen.act(async () => { screen.trade().focus(); screen.trade().click(); }); };
  return { ...screen, asked, sent, tick, answer, click, holdTrade, finishTrade: () => release!({ status: "traded" }) };
}

test("one press submits the sealed quote as soon as it arrives and shows success after confirmation", async (t) => {
  const screen = await freshQuoteSwap(t);
  screen.holdTrade.on = true;
  await screen.click();
  assert.equal(screen.asked.length, 2, "the press asks for the sealed quote");
  assert.deepEqual(screen.sent, []);
  assert.equal(screen.trade().getAttribute("aria-busy"), "true");
  assert.equal(swapDom.document.activeElement, screen.trade());
  await screen.click();
  assert.equal(screen.asked.length, 2, "another press while quoting asks nothing");
  await screen.answer(2);
  assert.deepEqual(screen.sent, ["q1.fresh-2"]);
  assert.match(screen.trade().textContent!, /Swapping/);
  assert.doesNotMatch(screen.trade().textContent!, /Successful/);
  await screen.click();
  assert.deepEqual(screen.sent, ["q1.fresh-2"], "another press while sending does not trade");
  await screen.act(async () => screen.finishTrade());
  assert.equal(screen.trade().textContent, "Successful");
  assert.equal(screen.container.querySelector('[role="status"]')!.textContent, "Swap successful.");
});

test("a lower signed minimum waits for a fresh press even if the estimate is above the shown minimum", async (t) => {
  const screen = await freshQuoteSwap(t);
  await screen.click();
  await screen.answer(2, { amount_out: "341000000", min_out: "339295000" });
  assert.deepEqual(screen.sent, []);
  assert.match(screen.container.textContent!, /Price changed\. Review the new minimum\./);
  assert.match(screen.container.textContent!, /at least 339\.29\sUSDC/);
  assert.equal(screen.trade().textContent, "Confirm swap");
  assert.equal(swapDom.document.activeElement, screen.trade());
  await screen.click();
  assert.deepEqual(screen.sent, ["q1.fresh-2"]);
  assert.equal(screen.asked.length, 2, "accepting the new price uses the same sealed quote");
});

test("a low payout first seen on the sealed quote is shown before another press can send it", async (t) => {
  const screen = await freshQuoteSwap(t, { price_impact_bps: 1_250 });
  assert.match(screen.container.textContent!, /High price impact/);
  await screen.click();
  await screen.answer(2, { amount_in_usd: "3200.00", amount_out_usd: "342.00", price_impact_bps: 125 });
  assert.deepEqual(screen.sent, [], "nothing is signed before the warning is shown");
  const descriptions = screen.trade().getAttribute("aria-describedby")!.split(" ");
  assert.match(descriptions.map((id) => swapDom.document.getElementById(id)?.textContent).join(" "), /Low payout.*89% below/);
  assert.equal(screen.trade().textContent, "Confirm swap");
  await screen.click();
  assert.deepEqual(screen.sent, ["q1.fresh-2"]);
});

test("editing the amount while sealing prevents the previous amount from trading", async (t) => {
  const screen = await freshQuoteSwap(t);
  await screen.click();
  await screen.type("101");
  await screen.answer(2);
  assert.deepEqual(screen.sent, []);
});

test("closing the screen while sealing prevents the trade from sending", async (t) => {
  const screen = await freshQuoteSwap(t);
  await screen.click();
  await screen.unmount();
  await screen.answer(2);
  assert.deepEqual(screen.sent, []);
});

test("MA-8: while the first answer is asked the button keeps its name; the indicator, named for the wait, shows only after 300 ms", () => {
  const html = renderToStaticMarkup(<LoadingIndicator label={FINDING_PRICE}>Swap</LoadingIndicator>);
  assert.match(html, /role="status"/);
  assert.match(html, new RegExp(`aria-label="${FINDING_PRICE}"`));
  assert.match(html, /<span aria-hidden="true" class="[^"]*actionLabel[^"]*">Swap<\/span>/);
  const css = readFileSync(new URL("../../blast-ui/LoadingIndicator.module.css", import.meta.url), "utf8");
  assert.match(css, /\.spinner \{[^}]*animation:[^;}]*loadingWait var\(--t4\) step-end/, "the ring waits --t4 (300 ms) before it shows");
  assert.match(css, /\.actionLabel \{[^}]*animation: loadingHold var\(--t4\) step-end/, "the label holds until then");
});
