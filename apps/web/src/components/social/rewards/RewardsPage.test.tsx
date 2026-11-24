import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PortfolioView,
  type PortfolioViewData,
} from "../portfolio/PortfolioView";
import { RewardsSection, type RewardsPageData } from "./RewardsPage";
import { staticRounds } from "../../../../test/fixtures/social/rewards/static-rounds.ts";
import {
  CoinGroup,
  RewardsSideCard,
  useRowContext,
  type RowContext,
} from "./RewardsParts";
import { rewardsFixture } from "../../../../test/fixtures/social/rewards/rewards-fixture.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

/**
 * OA-45, OA-46: Rewards' markup against the oa46 gate's `rwTabHTML`,
 * `viewRewards`, `rwCoinHTML`, `rwSideHTML` and `rwHowHTML`: the Portfolio
 * tab, the page in each state, the side cards.
 */

const sample = rewardsFixture("ready");
installTestDom();
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function Side({ hidden = false }: Readonly<{ hidden?: boolean }>) {
  const ctx = useRowContext(sample.nowMs, hidden);
  return (
    <RewardsSideCard coins={sample.coins} ctx={ctx} latest={sample.latest} />
  );
}

const page = (
  over: Partial<RewardsPageData> = {},
  state = sample,
  hidden = false,
) =>
  renderToStaticMarkup(
    <RewardsSection
      data={{
        mode: "ready",
        status: state.status,
        coins: state.coins,
        latest: state.latest,
        retry: () => undefined,
        ...over,
      }}
      hidden={hidden}
      nowMs={state.nowMs}
      Rounds={staticRounds(state.byCoin)}
      signIn={
        <a className="btn btn-primary" href="/sign-in">
          Sign in
        </a>
      }
    />,
  );

test("rewards and expanded payout reads use layout skeletons without visible loading copy", () => {
  const container = document.createElement("div");
  container.innerHTML = page({ status: "loading" });
  const skeleton = container.querySelector('[role="status"][aria-label="Loading rewards"]')!;
  assert.equal(skeleton.getAttribute("aria-busy"), "true");
  assert.equal(skeleton.querySelector(".fig, .coin, button, a"), null);
  assert.equal(skeleton.querySelector(".sr-only")?.textContent, "Loading rewards");
  const visible = container.cloneNode(true) as HTMLElement;
  visible.querySelectorAll('.sr-only, [aria-hidden="true"]').forEach((node) => node.remove());
  assert.doesNotMatch(visible.textContent!, /Loading|See what’s trending/);

  const coin = sample.coins[1]!;
  const rows = sample.byCoin.get(coin.sourceId)!.slice(0, 1);
  for (const loadingMore of [false, true]) {
    container.innerHTML = renderToStaticMarkup(
      <CoinGroup
        coin={coin}
        ctx={{ nowMs: sample.nowMs, hidden: false, explorer: "Suiscan", href: (digest) => `https://example.invalid/tx/${digest}` }}
        open
        onToggle={() => undefined}
        Rounds={({ children }) => children({ rows: loadingMore ? rows : [], status: loadingMore ? "ready" : "loading", more: true, loadingMore, loadMore: () => undefined, retry: () => undefined })}
      />,
    );
    const pending = container.querySelector('[aria-label="Loading payouts"]')!;
    assert.equal(pending.querySelectorAll('.row').length, loadingMore ? 10 : 5);
    assert.equal(pending.querySelectorAll('a, button').length, 0);
    if (loadingMore) {
      assert.equal(container.querySelectorAll('.panel a').length, 1, "loaded payouts stay visible while more arrive");
      assert.equal(container.querySelector<HTMLButtonElement>('button[aria-busy="true"]')!.disabled, true);
    }
    assert.doesNotMatch(container.textContent!, /Loading payouts/);
  }
});

test("reward panels retain closing content but immediately remove keyboard access", async (t) => {
  const Rounds = staticRounds(sample.byCoin);
  const ctx: RowContext = {
    nowMs: sample.nowMs, hidden: false, explorer: "Suiscan",
    href: (digest) => `https://example.invalid/tx/${digest}`,
  };
  function Probe() {
    const [open, setOpen] = useState(true);
    return <CoinGroup coin={sample.coins[0]!} ctx={ctx} onToggle={setOpen} open={open} Rounds={Rounds} />;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<Probe />));
  const toggle = container.querySelector<HTMLButtonElement>("[aria-expanded]")!;
  const panel = container.querySelector<HTMLDivElement>("[role=region]")!;
  assert.equal(panel.hidden, false);
  assert.equal(panel.hasAttribute("inert"), false);
  await act(async () => { toggle.focus(); toggle.click(); });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(panel.getAttribute("aria-hidden"), "true");
  assert.equal(panel.hasAttribute("inert"), true);
  assert.match(panel.textContent!, /Round 6/, "payouts remain available to finish the exit transition");
  assert.equal(document.activeElement, toggle);
  await act(async () => toggle.click());
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(panel.hidden, false);
  assert.equal(panel.hasAttribute("inert"), false);
  assert.equal(panel.hasAttribute("aria-hidden"), false);
});

test("OA-45, TS-5: Portfolio's Claims tab shows the rewards that came in", async (t) => {
  const data: PortfolioViewData = {
    mode: "ready",
    portfolio: "ready",
    figures: { total: 1, coins: 1, committed: 0, claimable: 0 },
    today: null,
    isPublic: false,
    coins: [],
    prices: new Map(),
    holdings: { created: [], positions: [], watchlist: [], coins: [], vestings: [] },
    holdingsFailed: false,
    hidden: false,
    rewards: {
      status: "ready",
      coins: sample.coins,
      latest: sample.latest,
      retry: () => undefined,
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(withQueryClient(createTestQueryClient(), <AppRouterContext value={router}><PortfolioView data={data} nowMs={sample.nowMs} /></AppRouterContext>)),
  );
  const tab = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('#pfTabs [role="tab"]')].find((button) => button.textContent === label)!;
  await act(async () => tab("Claims").click());
  const html = container.innerHTML;
  assert.deepEqual(
    [...container.querySelectorAll('#pfTabs [role="tab"]')].map((button) => button.textContent),
    ["Coins", "Presales", "Claims"],
  );
  assert.equal(tab("Claims").getAttribute("aria-selected"), "true");
  assert.match(
    text(html),
    /Claims .*Received ≈ \$21\.23.*By coin/,
  );
  assert.match(html, /aria-labelledby="pft-claims"[^>]*role="tabpanel"/);
  await act(async () => tab("Coins").click());
  const coins = container.innerHTML;
  assert.doesNotMatch(coins, /Latest/);
});

test("OA-46: the page — back to Portfolio, the two figures, By coin with one collapsed row per coin", () => {
  const html = page();
  assert.doesNotMatch(html, /See all|Latest|Back to Portfolio/);
  assert.match(text(html), /Received ≈ \$21\.23 At today’s prices Last payout 18 h ago Kestrel · Round 6 By coin 2 coins Kestrel Last 18 h ago · 6 payouts \+\$17\.80 USDC ≈ \$17\.80/);
  assert.doesNotMatch(html, /Round 6<\/b>/, "collapsed histories do not block asynchronous scroll restoration");
  // Two coins: both start collapsed, each a button that controls its region.
  assert.equal([...html.matchAll(/aria-expanded="false"/g)].length, 2);
  assert.equal([...html.matchAll(/hidden=""[^>]*role="region"/g)].length, 2);
  assert.match(html, /aria-controls="rwp-0x0{60}kstl" aria-expanded="false"/);
});

test("a single coin starts collapsed and opens its waiting share and payout history on request", async (t) => {
  const kstl = sample.coins[0]!;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(
    <RewardsSection
      data={{ mode: "ready", status: "ready", coins: [kstl], latest: sample.latest, retry: () => undefined }}
      hidden={false}
      nowMs={sample.nowMs}
      Rounds={staticRounds(sample.byCoin)}
    />,
  ));
  const toggle = container.querySelector<HTMLButtonElement>("[aria-expanded]")!;
  const panel = container.querySelector<HTMLElement>('[role="region"]')!;
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(panel.hidden, true);
  assert.doesNotMatch(panel.textContent!, /Round 6/);
  await act(async () => toggle.click());
  const html = container.innerHTML;
  assert.match(html, /aria-expanded="true"/);
  assert.doesNotMatch(html, /hidden=""[^>]*role="region"/);
  assert.match(
    text(html),
    /Waiting \+\$1\.02 USDC Queued for automatic delivery Round 6 18 h ago .*Round 2 5 d ago .*Load more payouts \(1\)/,
  );
  assert.equal([...html.matchAll(/>Round \d+<\/b>/g)].length, 5);
  const lumen = sample.coins[1]!;
  const lhtml = page({
    coins: [lumen],
    latest: sample.latest.filter((p) => p.sourceId === lumen.sourceId),
  });
  assert.match(
    text(lhtml),
    /Waiting \+\$0\.14 USDC Queued for automatic delivery/,
  );
  // A share the relay set aside (no gate line): its holder claims it.
  const aside = {
    ...lumen,
    waiting: { next: null, unpayable: { coin: 12, quote: 0.02 } },
  };
  assert.match(
    text(
      page({
        coins: [aside],
        latest: sample.latest.filter((p) => p.sourceId === lumen.sourceId),
      }),
    ),
    /Waiting \+12 LUMN · \+\$0\.02 USDC Couldn’t be sent automatically\. Claim it yourself\./,
  );
});

test("standalone waiting rewards appear before the first payout", () => {
  const pending = {
    ...sample,
    coins: [{ ...sample.coins[0]!, sourceId: `0x${"f".repeat(64)}`, payouts: 0, lastMs: 0,
      received: { coin: 0, quote: 0 }, usd: 0,
      waiting: { next: { coin: 0, quote: 1 }, unpayable: null } }],
    latest: [],
    byCoin: new Map(),
  };
  const detail = text(page({}, pending));
  assert.match(detail, /Awaiting first payout/);
  assert.doesNotMatch(detail, /No rewards yet/);
  assert.match(detail, /Waiting \+\$1\.00 USDC/);
  assert.doesNotMatch(detail, /See all/);
});

test("OA-45: the page's states — signed out, loading, failed, empty", () => {
  assert.match(
    text(page({ mode: "visitor" })),
    /By coin Sign in to see your rewards Sign in/,
  );
  assert.match(
    page({ status: "loading" }),
    /aria-busy="true" aria-label="Loading rewards"/,
  );
  assert.match(page({ status: "error" }), /role="alert"/);
  assert.match(
    text(page({ status: "error" })),
    /Couldn’t load your rewards Your payouts are safe in your wallet\. This page could not read them right now\. Try again\. Code: request_failed\./,
  );
  assert.match(text(page({}, rewardsFixture("empty"))), /No rewards yet/);
  assert.doesNotMatch(page({ mode: "visitor" }), /≈|KSTL/);
});

test("OA-45: Portfolio's rewards side card", () => {
  // The Portfolio board: the title, the figure, what it is and how many payouts, the last payout, Open rewards.
  // Holder rewards arrive on their own, so there is no Claim rewards (REDESIGN-DATA-GAPS).
  assert.match(
    text(renderToStaticMarkup(<Side />)),
    /^Rewards \$21\.23 Received · \d+ payouts? \+\$2\.10 USDC Last payout · Kestrel · 18 h ago Queued for automatic delivery Open rewards$/,
  );
  assert.doesNotMatch(renderToStaticMarkup(<Side />), /Claim rewards|Ready to claim/);
  assert.match(
    text(renderToStaticMarkup(<Side hidden />)),
    /^Rewards •••• Received · \d+ payouts? •••• Last payout/,
  );
  const empty = rewardsFixture("empty");
  const ctxless = renderToStaticMarkup(
    <RewardsSideCard
      coins={empty.coins}
      ctx={{ nowMs: 0, hidden: false, explorer: "Suiscan", href: () => null }}
      latest={empty.latest}
    />,
  );
  assert.equal(ctxless, "");
});

test("OA-45: the phone switch fits its tabs responsively, and rows keep the gate's grid", () => {
  const portfolio = readFileSync(
    new URL("../portfolio/Portfolio.module.css", import.meta.url),
    "utf8",
  );
  // Five tabs at 320px: the shared `stretch` row sizes segments to their labels and scrolls instead of a local fixed grid.
  assert.doesNotMatch(portfolio, /\.tabs :global\(\.seg\) \{[^}]*grid-template-columns/);
  const shared = readFileSync(
    new URL("../../blast-ui/blast-ui.css", import.meta.url),
    "utf8",
  );
  assert.match(
    shared,
    /\.seg\[data-stretch\] \{ display: grid; width: 100%; grid-auto-columns: minmax\(max-content, 1fr\); overflow-x: auto;/,
  );
  const css = readFileSync(
    new URL("./Rewards.module.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /grid-template-columns: 40px minmax\(0, 1fr\) minmax\(84px, auto\) 18px;/,
  );
  assert.match(css, /\.panel \{ overflow: hidden; padding: 0 0 13px 54px; \}/);
});
