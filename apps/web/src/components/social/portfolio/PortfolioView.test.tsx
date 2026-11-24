import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "#web/test/css-design-px.ts";
import test, { afterEach } from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

import { NO_COST_BASIS, type SocialPortfolio } from "@blast/core/modules/social/contracts/portfolio.ts";
import { portfolioCoverage, portfolioFigures, pricedFigures } from "./portfolio-model.ts";
import type { SocialMePresales } from "@blast/core/modules/social/contracts/profile-page.ts";

import type { ClaimPath } from "../claim/claims";
import { FeedOverlaysProvider } from "../feed-ui/shell-bridge";
import { LaunchpadFlagProvider } from "#web/components/blast-ui/launchpad-flag.tsx";
import type { HoldingCoin } from "../profile/profile-model";
import type { PortfolioViewData } from "./PortfolioView";
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
const { setPortfolioTab } = await import("./portfolio-tab");
const vestingHooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "./use-vesting-wallet") return { url: 'data:text/javascript,export function useVestingWallet() { return { wallet: null, walletLoading: false, walletError: false, busy: false, node: null }; }', shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { PortfolioView } = await import("./PortfolioView");
vestingHooks.deregister();

/**
 * R3-74: the Portfolio page's markup against the oa41 gate's `viewPortfolio`
 * (design/blast-trading-home-oa41.html 8884–8948): the signed-out card, the
 * hero's chip (a link to Settings) and eye, the figures, and the holdings
 * card's tablist (roving tabindex, its panel) with the coin rows.
 */
const COINS: readonly HoldingCoin[] = [
  { key: "usdc", name: "USDC", symbol: "USDC", presaleId: null, icon: "/blast-ui/coins/usdc.svg", round: true, usd: 860, quantity: 860 },
  { key: "sui", name: "SUI", symbol: "SUI", presaleId: null, icon: "/blast-ui/coins/sui.svg", round: true, usd: 1410.34, quantity: 412.38 },
];
const HOLDINGS: SocialMePresales = { created: [], positions: [], watchlist: [], coins: [], vestings: [] };
const DATA: PortfolioViewData = {
  mode: "ready",
  portfolio: "ready",
  figures: { total: 4760.34, coins: 3660.34, committed: 850, claimable: 250 },
  today: { usd: 224.84, pct: 4.96 },
  isPublic: false,
  coins: COINS,
  prices: new Map(),
  holdings: HOLDINGS,
  holdingsFailed: false,
  hidden: false,
  rewards: { status: "loading", coins: [], latest: [], retry: () => undefined },
};
let close: (() => Promise<void>) | undefined;
/** The request's launchpad flag the shell would provide. */
let launchpadOn = true;
let rerender: ((data: Partial<PortfolioViewData>) => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });
const render = async (data: Partial<PortfolioViewData> = {}, tab: "coins" | "presales" | "claims" = "coins", path?: ClaimPath) => {
  await close?.();
  // Each fixture starts a fresh history entry; reload persistence has its own regression test.
  window.history.replaceState({}, "");
  setPortfolioTab("coins");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  close = async () => { await act(async () => root.unmount()); container.remove(); };
  rerender = async (next) => { await act(async () => root.render(<AppRouterContext value={router}><LaunchpadFlagProvider value={launchpadOn}><FeedOverlaysProvider value={{ claimPath: path }}>
    <PortfolioView data={{ ...DATA, ...data, ...next }} nowMs={0} signIn={<a href="/sign-in">Sign in</a>} />
  </FeedOverlaysProvider></LaunchpadFlagProvider></AppRouterContext>)); };
  await rerender({});
  await act(async () => tabButton(container, tab)?.click());
  return container.innerHTML;
};
const TAB_LABEL = { coins: "Coins", presales: "Presales", claims: "Claims" } as const;
const tabButton = (root: ParentNode, tab: keyof typeof TAB_LABEL) =>
  [...root.querySelectorAll<HTMLButtonElement>('#pfTabs [role="tab"]')].find((button) => button.textContent === TAB_LABEL[tab]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("pending portfolio and holdings show skeletons, never invented balances or empty states", async () => {
  const pending = { mode: "loading" as const, portfolio: "loading" as const, holdings: null, coins: [], isPublic: null, today: null };
  for (const tab of ["coins", "presales"] as const) {
    const html = await render(pending, tab);
    assert.match(html, /aria-label="Loading (your holdings|presales|vestings)"/);
    assert.doesNotMatch(html, /\$0|No coins|Nothing vesting|No presales/);
  }
  const vestings = await render(pending, "claims");
  assert.doesNotMatch(vestings, /Presale allocations/);
  const coinsReady = await render({ holdings: null });
  assert.match(coinsReady, /USDC/);
  assert.doesNotMatch(coinsReady, /aria-label="Loading (your holdings|presales|vestings)"/);
});

test("history settles independently of the balance; no chart or range until there is history, and a failed read keeps its retry", async () => {
  const loading = { status: "loading" as const };
  const empty = { status: "ready" as const, trend: null, first: null, last: null };
  await render({ mode: "loading", portfolio: "loading", history: { "1w": loading, "1m": loading, all: loading } });
  const pending = document.querySelector('#pfHero [aria-label="Loading the value history"]')!;
  assert.ok(pending);
  await rerender!({ mode: "ready", portfolio: "ready", history: { "1w": empty, "1m": empty, all: empty } });
  const hero = document.querySelector("#pfHero")!;
  assert.equal(hero.querySelector('[aria-label="Loading the value history"]'), null);
  assert.equal(hero.querySelector('[aria-label="Range"]'), null);
  let retries = 0;
  const failed = { status: "error" as const, retry: () => { retries++; } };
  await rerender!({ mode: "ready", portfolio: "error", history: { "1w": failed, "1m": failed, all: failed } });
  assert.doesNotMatch(hero.textContent!, /USD value unavailable|—/);
  assert.equal(hero.querySelector('[aria-label="Loading the value history"]'), null);
  await act(async () => [...hero.querySelectorAll("button")].find(button => button.textContent === "Try again")!.click());
  assert.equal(retries, 1);
});

test("R3-74-AC-1: signed out, the page offers a useful introduction without financial placeholders", async () => {
  const html = await render({ mode: "visitor" });
  assert.match(text(html), /Sign in to see your holdings/);
  assert.match(html, /pfHero/);
  assert.match(html, /pfHold/);
  assert.match(text(html), /Your coins, presales and unlocks/);
  assert.doesNotMatch(text(html), /Total value|Withdraw|Hide amounts/);
  assert.match(html, /role="tablist"/);
  assert.doesNotMatch(html, /4,760|3,660|224\.84|412\.38/);
});

test("public vesting lookup remains available without an owner account", async () => {
  for (const mode of ["visitor", "no-account"] as const) {
    const html = await render({ mode, holdings: null }, "claims");
    assert.match(text(html), /Open a public schedule by ID/);
    assert.match(html, /aria-label="Schedule ID"/);
    assert.doesNotMatch(html, /aria-label="Loading (your holdings|presales|vestings)"/);
    assert.match(html, /href="\/vesting\/new"/);
  }
});

test("R3-74-AC-1: the hero — Total value, the total in money() form, today's line, the three figures, Withdraw and Deposit", async () => {
  const t = text(await render());
  // The Portfolio board: the eye and the chip beside the label, the move's sign on the dollars, the tiles to the cent.
  assert.match(t, /Portfolio Withdraw Deposit Total value Only you \$4,760 \.34 \+\$224\.84 \(4\.96%\) today Value breakdown Coins \$3,660\.34 In presales \$850\.00 To claim \$250\.00 Deposit Withdraw/);
  // An unknown move: no line, and the box keeps its height (CSS min-height).
  assert.doesNotMatch(text(await render({ today: null })), /today/);
});

test("the hero's range switch (Portfolio board): it opens on 1W's line, 1D is today's move, an uncovered range explains its state", async () => {
  const { historyRead } = await import("./portfolio-history");
  const week = historyRead({ range: "1w", points: [{ day: "2026-10-20", value_usd: "12168.00" }, { day: "2026-10-27", value_usd: "12480.40" }], change_bps: "257" }, false, () => undefined);
  const history = { "1w": week, "1m": historyRead({ range: "1m", points: [], change_bps: null }, false, () => undefined), all: { status: "loading" as const } };
  const pressed = (range: HTMLElement) => [...range.querySelectorAll("button")].map((button) => [button.textContent, button.getAttribute("aria-pressed"), button.disabled]);
  await render({ history });
  const range = document.querySelector<HTMLElement>('#pfHero [role="group"][aria-label="Range"]')!;
  // Owner, 2026-10-27: 1D has no line yet (one snapshot a day), so the page opens on the week.
  assert.deepEqual(pressed(range), [["1D", "false", false], ["1W", "true", false], ["1M", "false", false], ["All", "false", false]]);
  assert.match(document.querySelector("#pfHero")!.textContent!, /\+\$312\.40 \(2\.57%\) past week/);
  assert.match(document.querySelector("#pfHero [role=img]")!.getAttribute("aria-label")!, /Portfolio value, past week, up \+\$312\.40/);
  await act(async () => range.querySelectorAll("button")[0]!.click());
  assert.match(document.querySelector("#pfHero")!.textContent!, /\+\$224\.84 \(4\.96%\) today/);
  assert.equal(document.querySelector("#pfHero [role=img]"), null, "1D draws no line: one snapshot a day");
  await act(async () => range.querySelectorAll("button")[3]!.click());
  assert.ok(document.querySelector('#pfHero [aria-label="Loading the value history"]'), "a pending range keeps the chart's height");
  await rerender!({ history, hidden: true });
  assert.equal(document.querySelector("#pfHero [role=img], #pfHero [aria-label='Loading the value history']"), null, "masked amounts hide the line too");
  await render({ history: undefined });
  assert.equal(document.querySelector('#pfHero [aria-label="Range"]'), null, "without the read there is no switch");
  // An empty chosen range with no line in any range: no switch and no empty frame (the chart waits for history).
  const emptyWeek = historyRead({ range: "1w", points: [], change_bps: null }, false, () => undefined);
  await render({ history: { ...history, "1w": emptyWeek } });
  assert.equal(document.querySelector('#pfHero [aria-label="Range"]'), null, "no history yet: no switch");
  assert.doesNotMatch(document.querySelector("#pfHero")!.textContent!, /No value history/);
  // With a line in another range, an empty week keeps the chosen range and says so in the chart's footprint.
  const allLine = historyRead({ range: "all", points: [{ day: "2026-09-01", value_usd: "9000.00" }, { day: "2026-10-27", value_usd: "12480.40" }], change_bps: "3867" }, false, () => undefined);
  await render({ history: { ...history, "1w": emptyWeek, all: allLine } });
  assert.deepEqual(pressed(document.querySelector<HTMLElement>('#pfHero [role="group"][aria-label="Range"]')!).slice(0, 2), [["1D", "false", false], ["1W", "true", false]]);
  assert.match(document.querySelector("#pfHero")!.textContent!, /No value history in this range/);
  assert.equal(document.querySelector('#pfHero [aria-label="Loading the value history"]'), null);
});

test("R3-74-AC-2: the chip links to Settings and reads the account's setting; the eye masks every amount", async () => {
  assert.match(await render(), /<a class="[^"]*" href="\/settings">.*Only you<\/a>/);
  assert.match(await render({ isPublic: true }), /href="\/settings"[^>]*>.*Public<\/a>/);
  assert.doesNotMatch(await render({ isPublic: null }), /href="\/settings"/);
  const hidden = await render({ hidden: true });
  assert.match(hidden, /aria-label="Show amounts" aria-pressed="true"/);
  assert.match(text(hidden), /\$•••••• Hidden today Value breakdown Coins •••• In presales •••• To claim ••••/);
  assert.doesNotMatch(text(hidden), /\$\d/);
});

test("R3-74-AC-3: the switch is a tablist with a roving tabindex and one panel; each figure names its tab", async () => {
  const html = await render({}, "presales");
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('#pfTabs [role="tab"]')].map((tab) => [tab.textContent, tab.getAttribute("aria-selected"), String(tab.tabIndex)]);
  assert.deepEqual(tabs, [["Coins", "false", "-1"], ["Presales", "true", "0"], ["Claims", "false", "-1"]]);
  // The board's switch sizes its tabs to their labels; phones stretch it in the module's layout.
  assert.match(html, /aria-label="Holdings" class="seg" id="pfTabs" role="tablist"/);
  assert.deepEqual([...document.querySelectorAll('#pfTabs [role="tab"]')].map((tab) => [tab.id, tab.getAttribute("aria-controls")]), [["pft-coins", "pfBody2"], ["pft-presales", "pfBody2"], ["pft-claims", "pfBody2"]]);
  assert.match(html, /aria-labelledby="pft-presales" class="[^"]*" id="pfBody2" role="tabpanel"/);
  assert.deepEqual([...html.matchAll(/data-figure="(\w+)"/g)].map((m) => m[1]), ["coins", "presales", "claim"]);
  // The hero's tiles carry the sums; the switch does not repeat them.
  assert.doesNotMatch(text(html), /\$850 in|to claim/);
  await act(async () => document.querySelector<HTMLElement>('#pfTabs [aria-selected="true"]')!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  assert.equal(document.querySelector('#pfTabs [aria-selected="true"]')?.textContent, "Claims");
  assert.equal(document.activeElement?.textContent, "Claims");
});

test("the hero's allocation bar draws each figure's share, carries no amounts, and hides while masked or loading", async () => {
  await render();
  const shares = [...document.querySelectorAll<HTMLElement>('#pfHero [aria-hidden="true"] > i[data-k]')];
  assert.deepEqual(shares.map((share) => [share.dataset.k, Number(share.style.flexGrow).toFixed(3)]), [["coins", "0.769"], ["presales", "0.179"], ["claim", "0.053"]]);
  assert.equal(shares[0]!.closest("[aria-hidden]")!.textContent, "");
  const colors = ["var(--ink)", "var(--ink-tint-2)", "var(--ink-tint-1)"];
  assert.deepEqual(shares.map(share => share.dataset.crColor), colors);
  const legend = [...document.querySelectorAll<HTMLElement>("#pfHero [data-figure] i[data-k]")];
  assert.deepEqual(legend.map(key => [key.dataset.k, key.dataset.crColor]), [
    ["coins", "var(--ink)"], ["presales", "var(--ink-tint-2)"], ["claim", "var(--ink-tint-1)"],
  ]);
  await render({ hidden: true });
  assert.equal(document.querySelectorAll("#pfHero i[data-k]").length, 0);
  await render({ portfolio: "loading" });
  assert.equal(document.querySelectorAll("#pfHero i[data-k]").length, 0);
  await render({ figures: { total: null, coins: null, committed: 850, claimable: 250 } });
  assert.equal(document.querySelectorAll("#pfHero i[data-k]").length, 0, "a partial valuation never draws a whole");
});

test("a zero allocation leaves the next shade for the next visible segment", async () => {
  await render({ figures: { total: 400, coins: 100, committed: 0, claimable: 300 } });
  const shares = [...document.querySelectorAll<HTMLElement>('#pfHero [aria-hidden="true"] > i[data-k]')];
  assert.deepEqual(shares.map(share => [share.dataset.k, share.dataset.crColor, share.style.flexGrow]), [
    ["coins", "var(--ink)", "0.25"], ["claim", "var(--ink-tint-2)", "0.75"],
  ]);
  const legend = [...document.querySelectorAll<HTMLElement>("#pfHero [data-figure] i[data-k]")];
  assert.deepEqual(legend.map(key => [key.dataset.k, key.dataset.crColor]), [
    ["coins", "var(--ink)"], ["claim", "var(--ink-tint-2)"],
  ]);
  assert.equal(text(document.querySelector('#pfHero [data-figure="presales"]')!.innerHTML).trim(), "In presales $0.00");
});

test("under a priced subtotal the bar draws the known split, and one note explains partial values", async () => {
  // Every holding read; one coin and part of the claims have no price yet.
  const portfolio: SocialPortfolio = {
    balances: { sui: { atoms: "0", usd: "0.00" }, usdc: { atoms: "600000000", usd: "600.00" } },
    positions: [], vesting: null, totals: null, trend: null, prices_as_of_ms: null, unavailable: [],
    commitments: { committed_usd: "300.00", claimable_usd: null, known_claimable_usd: "100.00" },
    coins: [
      { coin_type: "0x1::kstl::KSTL", symbol: "KSTL", balance: "1", value_usd: null, ...NO_COST_BASIS },
      { coin_type: "0x1::lumn::LUMN", symbol: "LUMN", balance: "1", value_usd: "0.00", ...NO_COST_BASIS },
    ],
  };
  await render({ figures: portfolioFigures(portfolio), valuation: portfolioCoverage(portfolio), priced: pricedFigures(portfolio), today: null });
  const shares = [...document.querySelectorAll<HTMLElement>('#pfHero [aria-hidden="true"] > i[data-k]')];
  assert.deepEqual(shares.map((share) => [share.dataset.k, Number(share.style.flexGrow).toFixed(3)]), [["coins", "0.600"], ["presales", "0.300"], ["claim", "0.100"]]);
  assert.match(text(document.querySelector("#pfHero")!.innerHTML), /Portfolio value .*\$1,000 \.00 .*Some assets have no price/);
  assert.deepEqual([...document.querySelectorAll("#pfHero [data-figure]")].map((tile) => text(tile.innerHTML).trim()), ["Coins $600.00", "In presales $300.00", "To claim $100.00"]);
  assert.equal(document.querySelectorAll("#pfHero [data-figure] i[data-k]").length, 3, "every segment keeps its tile");
  await render({ figures: portfolioFigures(portfolio), valuation: portfolioCoverage(portfolio), priced: pricedFigures(portfolio), today: null, hidden: true });
  assert.equal(document.querySelectorAll("#pfHero i[data-k]").length, 0, "masked amounts draw no shares");
});

test("R3-74-AC-4: coin rows — no price history leaves the sparkline slot empty and no move; USDC omits redundant Cash category", async () => {
  const html = await render();
  assert.equal([...html.matchAll(/data-slot="portfolio-coin-sparkline"><\/span>/g)].length, 2);
  assert.match(html, /aria-label="USDC, 860 USDC, \$860\.00"/);
  assert.match(html, /aria-label="Sui, 412\.38 SUI, \$1,410\.34"/);
  assert.match(text(html), /USDC 860 USDC \$860\.00/);
  for (const coin of COINS) {
    assert.ok(document.querySelector(`[data-list-row="${coin.key}"] [data-coin-mark][data-coin-size="40"][data-coin-round]`), `${coin.symbol} uses a round 40 px mark`);
  }
  assert.doesNotMatch(text(html), /Cash/);
});

test("R3-74: the holdings card keeps its row geometry and sticks below the measured phone header", async () => {
  const css = readFileSync(new URL("./Portfolio.module.css", import.meta.url), "utf8");
  // The board's row: the 40px mark column, the name, the 96px line, the 132px value and the chevron.
  assert.match(css, /grid-template-columns: 40px minmax\(0, 1fr\) 96px 132px 18px;/);
  assert.match(css, /\.tabs \{\s*position: sticky;\s*top: calc\(env\(safe-area-inset-top, 0px\) \+ var\(--shell-topbar-height, 56px\)\);/);
  assert.match(css, /\.tabs \{ top: calc\(env\(safe-area-inset-top, 0px\) \+ var\(--shell-topbar-height, 104px\)\);/);
  assert.match(css, /\.hold \{ padding: 16px 10px 10px; border-radius: 24px;/);
  assert.match(css, /@media \(max-width: 1219px\) and \(min-width: 761px\) \{\s*\.sp \{ display: none; \}/);
});

test("R3-74: Presales and Claims draw the shared lists", async () => {
  const position = {
    presale: { presale_id: "0xm", symbol: "MRDN", name: "Meridian", icon_url: "", status: "open", venue: "cetus", start_ms: 0, end_ms: 3_600_000, fill_pct: 73, quote_symbol: "USDC", quote_decimals: 6, launched_ms: null, first_unlock_ms: null },
    committed_usd: "100.00", committed_atoms: "100000000", status: "open", claimed_tokens: null, refunded_usd: null, refunded_atoms: null, value_usd: null, multiple: null, ...NO_COST_BASIS,
  } as const;
  assert.match(text(await render({ holdings: { ...HOLDINGS, positions: [position] } }, "presales")), /Meridian \$100 committed Open 1h 0m left/);
  await render({}, "claims");
  const schedules = [...document.querySelectorAll("summary")].find(summary => summary.textContent?.includes("Vesting schedules"));
  assert.ok(schedules);
  assert.equal(schedules.closest("details")?.open, false);
  assert.match(text(await render({ holdings: null, holdingsFailed: true }, "claims")), /Your holdings could not load/);
});

test("LP-13: Launches lists the launches each linked wallet created, read in the browser, and asks a visitor to sign in", async () => {
  // The test has no app server: each wallet's read fails, and the list says so, never empty.
  const one = await render({ launchWallets: [`0x${"a1".repeat(32)}`] }, "claims");
  assert.match(text(one), /Launches couldn’t load/);
  assert.match(one, /<button[^>]*>Refresh<\/button>/);
  // "Your launches" is the last part of Claims; the creator-fees line above it may say "Launch a coin".
  assert.doesNotMatch(text(one).split("Your launches")[1] ?? "", /Created with|Launch a coin/);
  // Until the portfolio names the reader's wallets, the Launches and launchpad Rewards lists are pending, not blank.
  assert.match(await render({ mode: "loading", launchWallets: undefined }, "claims"), /aria-label="Loading your launches"/);
  const rewards = await render({ mode: "loading", launchWallets: undefined }, "claims");
  assert.match(rewards, /aria-label="Loading launchpad creator fees"/);
  assert.match(rewards, /aria-label="Loading launchpad holder rewards"/);
  const two = await render({ launchWallets: [`0x${"a1".repeat(32)}`, `0x${"b2".repeat(32)}`] }, "claims");
  assert.match(text(two), /Created with 0xa1a1…a1a1 .*Created with 0xb2b2…b2b2/);
  assert.match(text(await render({ mode: "visitor", launchWallets: [] }, "claims")), /Sign in to see your vestings/);
});

test("#602: while the launchpad is off Claims has no launchpad lists, and an old Launches link opens Claims", async () => {
  launchpadOn = false;
  try {
    await render({ launchWallets: [`0x${"a1".repeat(32)}`] });
    assert.deepEqual([...document.querySelectorAll("#pfTabs [role=tab]")].map((tab) => tab.textContent), ["Coins", "Presales", "Claims"]);
    const claims = await render({ mode: "loading", launchWallets: undefined }, "claims");
    assert.doesNotMatch(claims, /launchpad creator fees|launchpad holder rewards|launchpad creator rights|Your launches/i);
    // A client navigation to the old /portfolio/launches selects Claims and never reads /api/launchpad.
    window.history.replaceState(null, "", "/portfolio/launches");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
    await rerender!({ launchWallets: [`0x${"a1".repeat(32)}`] });
    assert.equal(document.querySelector('#pfTabs [aria-selected="true"]')?.textContent, "Claims");
    assert.doesNotMatch(document.querySelector("#pfBody2")?.textContent ?? "", /Launches couldn’t load/);
  } finally {
    launchpadOn = true;
  }
});

test("A-03, A-04, P-13: with a claim path a Presales or Claims row claims in place; without one its Claim links to the sale", async () => {
  const presale = { presale_id: "0xh", symbol: "HLCN", name: "Halcyon", icon_url: "", status: "cancelled", venue: "cetus", start_ms: 0, end_ms: 0, fill_pct: 40, quote_symbol: "USDC", quote_decimals: 6, launched_ms: 1, first_unlock_ms: null } as const;
  const position = { presale, committed_usd: "250.00", committed_atoms: "250000000", status: "claimable", claimed_tokens: "0", refunded_usd: null, refunded_atoms: null, value_usd: "0.00", multiple: null, ...NO_COST_BASIS } as const;
  const vesting = { schedule_id: `0x${"70".repeat(32)}`, presale: { ...presale, status: "trading" as const }, total: "400000", claimed: "25000", claimable: "1000", claimable_usd: null, start_ms: -10, cliff_end_ms: -10, end_ms: 1_000_000, vested_pct: 1 };
  const holdings = { ...HOLDINGS, positions: [position], vestings: [vesting] };
  const path = Object.assign(async () => ({ status: "failed", code: "x" }) as const, { kinds: ["claim_refund", "claim_tokens", "claim_vesting"] as const }) satisfies ClaimPath;
  const inPlace = async (tab: "presales" | "claims") => await render({ holdings }, tab, path);
  assert.match(await inPlace("presales"), /<button[^>]*data-claim="claim_refund"[^>]*>Claim refund<\/button>/);
  assert.match(await inPlace("claims"), /<button[^>]*data-claim="claim_vesting"[^>]*>Claim 1,000 HLCN<\/button>/);
  const balances = await inPlace("claims");
  assert.match(balances, /<dt>Claimed<\/dt><dd>25,000 <span>HLCN<\/span><\/dd>/);
  assert.match(balances, /<dt>Unclaimed<\/dt><dd>375,000 <span>HLCN<\/span><\/dd>/);
  assert.match(balances, /<dt>Available to claim<\/dt><dd>1,000 <span>HLCN<\/span><\/dd>/);
  assert.doesNotMatch(balances, /available now ·/);

  assert.match(await render({ holdings }, "presales"), /<a class="btn btn-primary btn-sm" href="\/presale\/0xh">Claim refund<\/a>/);
});

test("a confirmed presale claim removes its button before indexed holdings refresh", async () => {
  for (const status of ["trading", "cancelled"] as const) {
    const presale = { presale_id: "0xh", symbol: "HLCN", name: "Halcyon", icon_url: "", status, venue: "cetus", start_ms: 0, end_ms: 0, fill_pct: 100, quote_symbol: "USDC", quote_decimals: 6, launched_ms: 1, first_unlock_ms: null } as const;
    const position = { presale, committed_usd: "250.00", committed_atoms: "250000000", status: "claimable", claimed_tokens: "0", refunded_usd: null, refunded_atoms: null, value_usd: "0.00", multiple: null, ...NO_COST_BASIS } as const;
    let confirm: () => void = () => undefined;
    const path: ClaimPath = () => new Promise(resolve => { confirm = () => resolve({ status: "confirmed", digest: "digest" }); });
    await render({ holdings: { ...HOLDINGS, positions: [position] } }, "presales", path);
    await act(async () => document.querySelector<HTMLButtonElement>("[data-claim]")!.click());
    assert.match(document.body.textContent ?? "", /Claiming/);
    await act(async () => confirm());
    assert.equal(document.querySelector("[data-claim]") === null, true, "success must remove the claim button while holdings still say claimable");
    assert.match(document.body.textContent ?? "", status === "cancelled" ? /Refunded/ : /Claimed/);
    assert.doesNotMatch(document.body.textContent ?? "", /0 HLCN claimed/);
    assert.equal(position.status, "claimable", "the indexed position was not changed");
  }
});

test("vesting waits for its claimed total, then enables the next claim and rejects older snapshots", async () => {
  const presale = { presale_id: "0xh", symbol: "HLCN", name: "Halcyon", icon_url: "", status: "trading", venue: "cetus", start_ms: 0, end_ms: 0, fill_pct: 100, quote_symbol: "USDC", quote_decimals: 6, launched_ms: 1, first_unlock_ms: null } as const;
  const vesting = { schedule_id: `0x${"71".repeat(32)}`, presale, total: "10000000000000000", claimed: "9007199254740993.000000001", claimable: "1.000000009", claimable_usd: null, start_ms: -10, cliff_end_ms: -10, end_ms: 1_000_000, vested_pct: 1 };
  let calls = 0;
  const path: ClaimPath = async () => ({ status: "confirmed", digest: `digest-${++calls}` });
  await render({ holdings: { ...HOLDINGS, vestings: [vesting] } }, "claims", path);
  await act(async () => document.querySelector<HTMLButtonElement>("[data-claim]")!.click());
  assert.equal(document.querySelector("[data-claim]") === null, true, "a confirmed vesting claim has no stale action");
  assert.match(document.body.textContent ?? "", /Updating/);
  await rerender!({ holdings: { ...HOLDINGS, vestings: [{ ...vesting, claimed: "9007199254740993.000000002" }] } });
  assert.equal(document.querySelector("[data-claim]") === null, true, "a partial increase does not prove this claim was indexed");
  await rerender!({ holdings: { ...HOLDINGS, vestings: [{ ...vesting, claimed: "9007199254740994.000000010", claimable: "0.5" }] } });
  assert.match(document.querySelector("[data-claim]")?.textContent ?? "", /Claim 0.5 HLCN/);
  await act(async () => document.querySelector<HTMLButtonElement>("[data-claim]")!.click());
  assert.equal(calls, 2, "the newly unlocked amount can be claimed in the same session");
  await rerender!({ holdings: { ...HOLDINGS, vestings: [vesting] } });
  assert.equal(document.querySelector("[data-claim]") === null, true, "an older response cannot reopen the claimed action");
});


test("unlisted coins render their amounts and sync status without a presale action", async () => {
  const html = await render({ walletSync: "syncing", coins: [{
    key: "test-sui", name: "TEST_SUI", symbol: "TSUI", icon: "", round: true, presaleId: null,
    usd: null, quantity: null, quantityText: "10,000,000",
  }] });
  assert.match(text(html), /TEST_SUI 10,000,000 TSUI/);
  assert.match(html, /aria-label="Syncing your wallet coins"/);
  assert.match(html, /<div[^>]+data-k="test-sui"/);
  assert.doesNotMatch(html, /<button[^>]+data-k="test-sui"/);
});

test("page rows are real links (presale, Blast launch), a priced coin opens the sheet, spam stays text", async () => {
  const base = { icon: "", round: true, quantity: null, usd: null } as const;
  const html = await render({ coins: [
    { ...base, key: "0xp", name: "Sale", symbol: "SALE", presaleId: "0xp", round: false },
    { ...base, key: "0x9::meme::MEME", coinType: "0x9::meme::MEME", name: "Meme", symbol: "MEME", presaleId: null, launchId: "0xl" },
    { ...base, key: "0x9::wal::WAL", coinType: "0x9::wal::WAL", name: "Walrus", symbol: "WAL", presaleId: null, usd: 2 },
    { ...base, key: "0x9::spam::SPAM", coinType: "0x9::spam::SPAM", name: "Spam", symbol: "SPAM", presaleId: null },
  ] });
  assert.match(html, /<a[^>]+data-k="0xp"[^>]+href="\/presale\/0xp"/);
  assert.match(html, /<a[^>]+data-k="0x9::meme::MEME"[^>]+href="\/coin\/0x9%3A%3Ameme%3A%3AMEME"/);
  assert.match(html, /<button[^>]+aria-haspopup="dialog"[^>]+data-k="0x9::wal::WAL"/);
  assert.match(html, /<div[^>]+data-k="0x9::spam::SPAM"/);
  assert.doesNotMatch(html, /<(a|button)[^>]+data-k="0x9::spam::SPAM"/);
});

test("coin pages show global range and allow jumps while totals stay independent", async () => {
  let selected = 0;
  const controls = { search: "", page: 2, total: 103, pageSize: 20, loading: false, failed: false, onSearch: () => undefined, onPage: (page: number) => { selected = page; }, retry: () => undefined };
  const html = await render({ coinPage: controls });
  document.querySelector("[role=status]")!.parentElement!.scrollIntoView = () => undefined;
  assert.match(text(html), /21–40 of 103 coins/);
  // The board puts the search beside the switch, in the card's first row.
  assert.ok(document.querySelector('#pfHold > [class] input[aria-label="Search your coins"][placeholder="Search coins"]'));
  assert.doesNotMatch(text(html), /USD value|Core first/);
  assert.match(text(html), /\$4,760/);
  assert.ok(document.querySelector('nav[aria-label="Pages of coins"]'));
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click());
  assert.equal(selected, 3);
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Page 6"]')!.click());
  assert.equal(selected, 6);
});

test("Hide small balances is one shared checkbox with a one-line label", async () => {
  let hide: boolean | undefined;
  const controls = { search: "", page: 1, total: 2, pageSize: 20, loading: false, failed: false, hideSmall: true, onHideSmall: (value: boolean) => { hide = value; }, onSearch: () => undefined, onPage: () => undefined, retry: () => undefined };
  await render({ coinPage: controls });
  const box = document.querySelector<HTMLInputElement>('input[type="checkbox"][data-ui-checkbox]')!;
  assert.equal(box.closest("label")!.textContent, "Hide small balances");
  await act(async () => box.click());
  assert.equal(hide, false);
});

test("coin search distinguishes no matches, loading, failures, and empty wallets", async () => {
  let cleared = false;
  const controls = { search: "missing", page: 1, total: 0, pageSize: 20, loading: false, failed: false, onSearch: () => { cleared = true; }, onPage: () => undefined, retry: () => undefined };
  assert.match(text(await render({ coins: [], coinPage: controls })), /No matching coins/);
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Clear search")!.click());
  assert.ok(cleared);
  assert.match(await render({ coins: [], coinPage: { ...controls, loading: true } }), /Loading your holdings/);
  assert.match(text(await render({ coins: [], coinPage: { ...controls, failed: true } })), /Your coins could not load/);
  assert.match(text(await render({ coins: [], coinPage: { ...controls, search: "" } })), /No coins in your linked wallets/);
});

test("Rewards contains creator earnings whose actions carry the vault binding and hide amounts", async () => {
  const seen: import("../claim/claims").ClaimTarget[] = [];
  const path: ClaimPath = async (target) => { seen.push(target);return {status:"confirmed",digest:"confirmed"}; };
  const row={presale_id:`0x${"1".repeat(64)}`,vault_id:`0x${"2".repeat(64)}`,name:"Creator coin",symbol:"CC",icon_url:"",quote_symbol:"SUI",fee_share_bps:5000,collection_status:"ready" as const,collect:{meme:"12.34",quote:"0.5"},residuals:{meme:"56.78",quote:"0"},received:{meme:"10",quote:"1"}};
  const read={status:"ready" as const,earnings:[row],vestings:[],error:"",retry:()=>undefined,more:false,loadingMore:false,refreshing:false,refreshFailed:false,loadMore:()=>undefined};
  const html=await render({rewards:{status:"ready",coins:[],latest:[],retry:()=>undefined},creatorEarnings:read},"claims",path);
  assert.match(text(html),/Creator earnings/);
  assert.match(text(html),/≈12.34 CC ≈0.5 SUI/);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-claim="collect_fees"]')!.click());
  assert.equal(seen[0]!.vaultId,row.vault_id);
  assert.equal(seen[0]!.kind,"collect_fees");
  assert.match(document.querySelector('[data-claim-complete="collect_fees"]')!.textContent!,/Collected/);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-claim="claim_residuals"]')!.click());
  assert.equal(seen[1]!.vaultId,row.vault_id);
  assert.equal(seen[1]!.kind,"claim_residuals");
  await rerender!({hidden:true});
  assert.doesNotMatch(document.querySelector('[aria-label="Creator earnings"]')!.textContent!,/12.34|56.78|0.5 SUI|10 CC/);
  await rerender!({hidden:false,creatorEarnings:{...read,earnings:[{...row,received:{meme:"22.34",quote:"1.5"}}]}});
  assert.ok(document.querySelector('[data-claim="collect_fees"]'),"collection can repeat after indexed receipts advance");
});


test("unknown portfolio values omit their metrics and failed reads offer real retries", async () => {
  const unknown = { figures: { total: null, coins: null, committed: 850, claimable: 250 }, today: null } as const;
  const html = await render(unknown);
  assert.doesNotMatch(text(html), /Value unavailable|Some balances or prices are unavailable|Total value/);
  assert.doesNotMatch(text(html), /\$0/);
  // The empty value slot names its cause once: no prices, unread holdings (with a retry), or a late wallet.
  const hero = async (data: Partial<PortfolioViewData>) => { await render({ ...unknown, ...data }); return document.querySelector("#pfHero")!.textContent!; };
  assert.match(await hero({}), /These coins have no USD price yet\./);
  let retried = 0;
  assert.match(await hero({ holdingsUnread: true, retryPortfolio: () => { retried++; } }), /Some balances couldn’t load\.Try again/);
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("#pfHero button")].find(button => button.textContent === "Try again")!.click());
  assert.equal(retried, 1);
  assert.match(await hero({ walletSync: "stale", holdingsUnread: true }), /Wallet balances are late\. Showing the last known amounts\./);
  assert.doesNotMatch(document.body.textContent!, /Wallet balances are updating/, "the list does not repeat the hero");
  retried = 0;
  await render({ portfolio: "error", retryPortfolio: () => { retried++; } });
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Try again")!.click());
  assert.equal(retried, 1);
  await render({ holdings: null, holdingsFailed: true, retryHoldings: () => { retried++; } }, "presales");
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Try again")!.click());
  assert.equal(retried, 2);
});


test("an incomplete portfolio leads with its priced subtotal without claiming a complete total", async () => {
  const html = await render({ figures: { total: null, coins: null, committed: null, claimable: 0 }, valuation: { knownUsd: 12.34 }, today: null });
  assert.doesNotMatch(html, /Value unavailable|Total value/);
  assert.match(html, /Portfolio value<button/);
  assert.match(html, /\$12<span[^>]*>\.34<\/span>/);
  assert.match(html, /Some assets have no price/);
  const hidden = await render({ figures: { total: null, coins: null, committed: null, claimable: 0 }, valuation: { knownUsd: 12.34 }, today: null, hidden: true });
  assert.doesNotMatch(hidden, /12\.34/);
});

test("Portfolio preserves known commitments and refunds when their categories are incomplete", async () => {
  const portfolio: SocialPortfolio = {
    balances: { sui: { atoms: "0", usd: "0.00" }, usdc: { atoms: "0", usd: "0.00" } },
    positions: [], coins: [], commitments: { committed_usd: null, claimable_usd: null, known_committed_usd: "100.00", known_claimable_usd: "5.00" },
    vesting: null, totals: null, trend: null, prices_as_of_ms: null, unavailable: [],
  };
  const html = await render({ figures: portfolioFigures(portfolio), valuation: portfolioCoverage(portfolio), today: null });
  assert.doesNotMatch(html, /Value unavailable|Total value/);
  assert.match(html, /Portfolio value<button/);
  assert.match(html, /\$105<span[^>]*>\.00<\/span>/);
  assert.match(html, /Some assets have no price/);
});

test("vesting schedules remain accessible through the holdings tab without a repeated hero link", async () => {
  const html = await render({ vesting: { has_schedule: true, href: "/portfolio/vestings" },
    figures: { total: null, coins: null, committed: null, claimable: 0 } });
  assert.doesNotMatch(html, /View vesting schedules/);
  // The Claims tab is the way in, and selecting it puts its place in the URL.
  window.history.replaceState({}, "", "/portfolio");
  await act(async () => tabButton(document, "claims")!.click());
  assert.equal(window.location.pathname, "/portfolio/claims");
  window.history.replaceState({}, "", "/");
  assert.doesNotMatch(await render({ vesting: { has_schedule: true, href: "/portfolio/vestings" } }, "claims"), /View vesting schedules/);
  assert.doesNotMatch(await render({ vesting: { has_schedule: false, href: null } }), />View vesting schedules<\/a>/);
});

test("cached portfolio refresh failure preserves totals with a visible dated retry", async () => {
  let retries = 0;
  const html = await render({ refreshFailed: true, lastUpdatedMs: 1793000000000, retryPortfolio: () => { retries++; } });
  assert.match(text(html), /Refresh failed. Showing previous values from/);
  assert.match(html, /datetime="2026-10-26T07:33:20.000Z"/);
  const retry = [...document.querySelectorAll("button")].find(button => button.textContent === "Try again")!;
  await act(async () => retry.click());
  assert.equal(retries, 1);
  assert.match(text(html), /4,760/);
});
