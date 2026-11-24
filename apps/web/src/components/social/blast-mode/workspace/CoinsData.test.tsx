import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import type {
  HomeCoin,
  HomeCoinsPage,
} from "@blast/core/modules/social/contracts/home.ts";
import { DATA_VIEWS } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { createWorkspaceStore } from "./model";
import {
  encodeWorkspace,
  decodeWorkspace,
} from "@blast/core/modules/social/blast-workspace/codec.ts";
import { QueryObserver } from "@tanstack/react-query";
import { discoverQuery } from "../../coin-home/home-client";
import { HOME_DEFAULT_QUERY } from "@blast/core/modules/social/contracts/home.ts";
import { SocialViewerProvider, type SocialViewer } from "../../SignInGate";
import { WatchlistProvider } from "../../watchlist/Watchlist";

const coin: HomeCoin = {
  coin_type: "0x2::coin::KSTL",
  presale_id: null,
  symbol: "KSTL",
  name: "Kestrel",
  icon_url: null,
  decimals: 9,
  lifecycle: "migrated",
  venue: "cetus",
  tradable: true,
  opened_ms: null,
  launched_ms: 1000,
  launch_id: null,
  quote: { type: "0x2::sui::SUI", symbol: "SUI", decimals: 9 },
  sale: null,
  price_usd: "0.00000000000000000012345",
  price_as_of_ms: Date.now(),
  change_24h_bps: null,
  holders: null,
  holders_as_of_ms: null,
  fdv_usd: null,
  spark: [],
  activity: {
    scope: "pool",
    window: "24h",
    from_ms: 0,
    to_ms: Date.now(),
    participants: 0,
    buyers: 0,
    sellers: 0,
    backers: 0,
    claimers: 0,
    events: 0,
    bought: [],
    sold: [],
    committed: [],
    latest_ms: null,
    preview: [],
  },
  discussion: { posts: 0 },
  top_holders: { holders: [], share_bps: null },
  rank: { score: 0, why: "No recent activity" },
};
const answer: HomeCoinsPage = {
  coins: [coin],
  page: 1,
  pages: 2,
  total: 11,
  ranked: 0,
  next_cursor: null,
  window: "24h",
  clock_ms: Date.now(),
  as_of: { checkpoint: 1, timestamp_ms: Date.now(), lag_ms: 70_000 },
};

async function mounted(
  read: (
    url: string,
    signal?: AbortSignal | null,
    init?: RequestInit,
  ) => Promise<Response> = async () => Response.json(answer),
  viewer?: SocialViewer,
  reducedMotion = false,
) {
  const dom = new JSDOM(
    '<div data-blast-ui><main id="main"></main><div id="mount"></div></div>',
    { url: "https://blast.test/?sort=newest", pretendToBeVisual: true },
  );
  Object.assign(globalThis, {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    AbortController: dom.window.AbortController,
    AbortSignal: dom.window.AbortSignal,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.matchMedia = (query) =>
    ({
      matches: reducedMotion && query.includes("prefers-reduced-motion"),
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  dom.window.scrollTo = () => {};
  // JSDOM has no layout observer; geometry is covered by browser verification.
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { ResizeObserver });
  dom.window.HTMLElement.prototype.getAnimations = () => [];
  dom.window.HTMLElement.prototype.animate = () => {
    const animation = { cancel() {}, onfinish: null as null | (() => void) };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
  dom.window.HTMLElement.prototype.scrollTo = function (options) {
    if (typeof options === "object") this.scrollTop = options.top ?? this.scrollTop;
  };
  // Base UI detects browser capabilities when its modules first load.
  const { WorkspaceHost } = await import("./WorkspaceHost");
  const { useWorkspace } = await import("./workspace-context");
  function OpenDiscover() {
    const { dispatch } = useWorkspace();
    return <button type="button" onClick={() => dispatch.setDataCollapsed(false)}>Test open Discover</button>;
  }
  const { CoinsData } = await import("./CoinsData");
  const before = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push(String(input));
    return read(String(input), init?.signal, init);
  };
  const client = createTestQueryClient();
  const store = createWorkspaceStore();
  const root = createRoot(document.getElementById("mount")!);
  await act(async () => {
    root.render(
      <QueryProvider client={client}>
        <SocialViewerProvider
          signedIn={viewer?.signedIn ?? false}
          callsign={viewer?.callsign}
          getAccessToken={viewer?.getAccessToken}
        >
          <WatchlistProvider
            signedIn={viewer?.signedIn ?? false}
            viewerKey={viewer?.callsign ?? "guest"}
            getAccessToken={viewer?.getAccessToken}
          >
            <WorkspaceHost
              ownerKey="account"
              resolveOwner={async () => ({
                kind: "account",
                account_id: "reader",
                store,
              })}
              entryGeneration={1}
              onExit={() => {}}
              slots={{
                controls: <OpenDiscover />,
                data: { Coins: CoinsData },
                panel: ({ panel }) => <p>{panel.coin_type}</p>,
              }}
            />
          </WatchlistProvider>
        </SocialViewerProvider>
      </QueryProvider>,
    );
  });
  // Discover is a closed sheet on entry; exercise the reader after opening it.
  await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "Test open Discover")!.click());
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }
  await settle();
  const click = async (label: string) => {
    if (label === "Discover coins") label = "Test open Discover";
    if (label === "Close asset browser") label = "Collapse discovery";
    if (DATA_VIEWS.some((view) => view === label)) {
      const tab = document.querySelector<HTMLButtonElement>(
        `[role="tablist"][aria-label="What to discover"] #workspace-data-tab-${label}`,
      );
      if (tab) await act(async () => tab.click());
      else {
        await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="More views:"]')!.click());
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((option) => option.textContent!.replace(/\s*✓\s*$/, "").trim() === label)!;
        await act(async () => item.click());
      }
      await settle();
      return;
    }
    // Secondary lists are reached through the named Filters tray.
    if (label === "Discover") label = "Trending";
    if (label === "Following" || label === "Ecosystem" || label === "All" || label === "Most held") {
      const filters = document.querySelector<HTMLButtonElement>('button[title="Filters"]')!;
      if (filters.getAttribute("aria-expanded") !== "true") await act(async () => filters.click());
      // Following is a list; Most held is one of Sort's orders.
      const trigger = document.querySelector<HTMLButtonElement>(label === "Most held" ? 'button[aria-label^="Sort:"]' : 'button[aria-label^="More coin lists:"]');
      assert.ok(trigger, "Coin source pill");
      await act(async () => { trigger.focus(); trigger.click(); });
      const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
        .find((item) => item.textContent?.replace(/\s*✓\s*$/, "").trim() === label);
      assert.ok(option, `Coin source option: ${label}`);
      await act(async () => option.click());
      await settle();
      return;
    }

    const button = [...document.querySelectorAll("button")].find(
      (button) =>
        button.getAttribute("aria-label") === label ||
        button.textContent === label,
    );
    assert.ok(button, label);
    await act(async () => button.click());
    await settle();
  };
  return {
    dom,
    store,
    client,
    requests,
    click,
    settle,
    async dispose() {
      await act(async () => root.unmount());
      client.clear();
      globalThis.fetch = before;
      dom.window.close();
    },
  };
}

test("Coins reads public discovery and only explicit Add promotes a standalone normalized asset", async () => {
  const page = await mounted();
  try {
    assert.equal(page.store.getSnapshot().visible_order.length, 0);
    assert.ok(page.requests.some((url) => url.startsWith("/api/social/home")));
    assert.match(document.body.textContent!, /Activity is delayed/);
    assert.ok(
      document.querySelector(
        '[aria-label="Inspect full price in USD: 0.00000000000000000012345"]',
      ),
    );
    assert.equal(document.querySelector('[aria-label*="FDV availability"]'), null, "FDV is not on the row");
    await page.click("Open KSTL in Focus");
    const first = page.store.getSnapshot().visible_order[0]!;
    assert.equal(page.store.getSnapshot().panels[first]!.presale_id, null);
    assert.equal(
      page.store.getSnapshot().panels[first]!.coin_type,
      `0x${"2".padStart(64, "0")}::coin::KSTL`,
    );
    assert.ok(document.querySelector('[aria-label="Asset browser"]'), "desktop discovery remains available after opening an asset");
    await page.click("Discover coins");
    assert.equal(document.querySelector('button[aria-label="Open KSTL in Focus"]')?.getAttribute("aria-current"), "true");
    await page.click("Open KSTL in Focus");
    assert.deepEqual(page.store.getSnapshot().visible_order, [first]);
    assert.equal(page.dom.window.location.search, "?sort=newest");
  } finally {
    await page.dispose();
  }
});

test("collapsed Coins retains only the displayed marks, stops reading, and opens the selected asset", async () => {
  const page = await mounted();
  try {
    await page.click("Collapse discovery");
    const rail = document.querySelector('nav[aria-label="Coins shortcuts"]');
    assert.ok(rail);
    assert.equal(rail.querySelectorAll("button").length, 1);
    const reads = page.requests.length;
    await page.settle();
    assert.equal(page.requests.length, reads, "a collapsed preview starts no discovery reads");
    await page.click("Open KSTL coin");
    const state = page.store.getSnapshot();
    assert.equal(state.data.collapsed, true);
    assert.equal(state.data.selected_view, "Coins");
    assert.equal(state.panels[state.visible_order[0]!]!.active_namespace, "coin");
    await page.click("Expand discovery");
    assert.ok(!document.querySelector('nav[aria-label="Coins shortcuts"]'));
    await page.click("Saved");
    await page.click("Collapse discovery");
    assert.ok(!document.querySelector('nav[aria-label="Coins shortcuts"]'), "a signed-out list cannot retain public-source icons");
  } finally {
    await page.dispose();
  }
});

test("Coins price freshness follows the response clock while unknown metrics stay omitted", async () => {
  let clock = 1_700_000_000_000;
  const currentCoin: HomeCoin = {
    ...coin,
    launched_ms: 1_699_999_940_000,
    price_as_of_ms: 1_699_999_880_000,
  };
  const page = await mounted(async () =>
    Response.json({
      ...answer,
      clock_ms: clock,
      coins: [
        currentCoin,
        {
          ...currentCoin,
          coin_type: "0x2::coin::UNKNOWN",
          price_usd: null,
        },
        {
          ...currentCoin,
          coin_type: "0x2::coin::UNDATED",
          price_usd: null,
          price_as_of_ms: null,
          launched_ms: null,
        },
      ],
    }),
  );
  try {
    assert.doesNotMatch(document.body.textContent!, /Stale price/);
    assert.ok(
      document.querySelector(
        '[aria-label="Inspect full price in USD: 0.00000000000000000012345"]',
      ),
    );
    clock = 1_700_000_000_001;
    await page.click("Refresh market prices");
    const rows = [...document.querySelectorAll("[data-workspace-row]")];
    assert.match(rows[0]!.getAttribute("title")!, /^Stale price · observed .+ ago/);
    assert.equal(rows[1]!.querySelector('[aria-label*="price availability"]'), null);
    assert.match(rows[1]!.getAttribute("title")!, /^Stale price · observed .+ ago/);
    assert.equal(rows[2]!.querySelector('[aria-label*="price availability"]'), null);
    assert.doesNotMatch(rows[2]!.textContent!, /Stale price/);
    assert.equal(page.store.getSnapshot().visible_order.length, 0);
  } finally {
    await page.dispose();
  }
});

test("Coins paging and controls restore independently across collapse and view changes", async () => {
  const page = await mounted(async (url) =>
    Response.json({
      ...answer,
      page:
        new URL(url, "https://blast.test").searchParams.get("page") === "2"
          ? 2
          : 1,
    }),
  );
  try {
    await page.click("Next page");
    assert.equal(page.store.getSnapshot().data.controls.Coins.page, 2);
    assert.ok(page.requests.some((url) => url.includes("page=2")));
    await page.click("Live rankings");
    await page.click("Close asset browser");
    const count = page.requests.length;
    await page.click("Discover coins");
    assert.ok(
      page.requests.length > count,
      "reopening refreshes the visible source",
    );
    await page.click("Traders");
    await page.click("Coins");
    assert.equal(page.store.getSnapshot().data.controls.Coins.page, 2);
    assert.equal(page.store.getSnapshot().data.controls.Coins.live, false);
    const saved = encodeWorkspace(page.store.getSnapshot());
    assert.ok(saved.ok);
    const restored = decodeWorkspace(saved.bytes);
    assert.ok(restored.ok);
    assert.deepEqual(
      restored.workspace.data.controls.Coins,
      page.store.getSnapshot().data.controls.Coins,
    );
    assert.equal(page.dom.window.location.search, "?sort=newest");
    // Controls live in the workspace; the device keeps only the Discover toggle's choice (Blast mode audit, pass C).
    // A browser also persists Discovery artwork for the collapsed rail.
    const storage = page.dom.window.localStorage;
    assert.ok(Object.keys(storage).every((key) => key === "blast.discover.chosen" || key.startsWith("blast.discovery-preview.")));
    assert.equal(page.dom.window.localStorage.getItem("blast.discover.chosen"), "1");
    assert.equal(page.store.getSnapshot().visible_order.length, 0);
  } finally {
    await page.dispose();
  }
});

test("Most held asks Discover for the most holders first and keeps the order in the setup", async () => {
  const page = await mounted();
  try {
    await page.click("Most held");
    assert.equal(page.store.getSnapshot().data.controls.Coins.sort, "held");
    assert.equal(page.store.getSnapshot().data.controls.Coins.source, "discover");
    assert.ok(page.requests.some((request) => new URL(request, "https://blast.test").searchParams.get("sort") === "held"));
  } finally {
    await page.dispose();
  }
});

test("a guest Following source stays private and does not fall back to public discovery", async () => {
  const page = await mounted();
  try {
    const before = page.requests.length;
    await page.click("Following");
    assert.match(document.body.textContent!, /Sign in to see who you follow/);
    assert.equal(page.requests.length, before);
    assert.equal(document.querySelector('[aria-label="Open KSTL in Focus"]'), null);
    await page.click("Saved");
    assert.match(document.body.textContent!, /Sign in to see your watchlist/);
    assert.equal(page.requests.length, before);
  } finally {
    await page.dispose();
  }
});

test("compact coin identity stays inspectable and ranking categories do not count as filters", async () => {
  const side = { count: 1, amounts: [], tokens: null, latest_ms: 1 };
  const participant = (callsign: string, followers: number | null, extra: object = {}) => ({
    key: `c:${callsign}`,
    actor: { type: "account" as const, callsign, display_name: callsign, avatar_url: `https://avatars.test/${callsign}.png`, x_handle: null, verified: false, path: `/@${callsign}` },
    followers,
    buys: side,
    sells: null,
    commits: null,
    claims: null,
    latest_ms: 1,
    latest_kind: "trade_buy" as const,
    events_total: 1,
    ...extra,
  });
  const preview = [
    participant("famous", 5_000),
    participant("seller", 9_999, { buys: null, sells: side, latest_kind: "trade_sell" }),
    participant("friend", 2, { relation: "followed" }),
  ];
  const page = await mounted(async () =>
    Response.json({ ...answer, coins: [{ ...coin, activity: { ...coin.activity, buyers: 48, preview } }] }),
  );
  try {
    const row = document.querySelector<HTMLElement>("[data-workspace-row]")!;
    // Line two carries the market's size (an empty window names itself, live audit F30); the row opens the coin.
    assert.match(row.textContent!, /No trades/);
    // Followed first, then by followers; sellers are not buyers; at most three faces.
    const faces = [...row.querySelectorAll<HTMLImageElement>("img[src^='https://avatars.test/']")].map((image) => image.src.replace(/^.*\/(\w+)\.png$/, "$1"));
    assert.deepEqual(faces, ["friend", "famous"], "recorded buyers overlap in the former plus slot");
    assert.equal(row.querySelector('button[aria-label="Open KSTL in Focus"] svg'), null, "the market opens from its name without a plus icon");
    assert.equal(row.querySelector('[aria-label*="indexed top holders"]'), null, "holding alone is not evidence of a buy");
    await page.click("View KSTL buyers · 24h");
    assert.ok(document.querySelector('[role="dialog"] a[href="/@friend"]'));
    assert.equal(document.querySelector('[role="dialog"] a[href="/@seller"]'), null);
    assert.equal(page.store.getSnapshot().visible_order.length, 0, "buyer profiles do not open a market");
    await page.click("Close");
    assert.equal(row.getAttribute("title"), "No recent activity", "the reason moves to the row's title");
    // The reason stays reachable without hover: the row button's description.
    const toggle = row.querySelector<HTMLButtonElement>('[aria-label="Open KSTL in Focus"]')!;
    assert.equal(document.getElementById(toggle.getAttribute("aria-describedby")!)?.textContent, "No recent activity");
    assert.equal(toggle.hasAttribute("aria-expanded"), false);
    // A sort other than the default is named on the rail and counted on the Filters button.
    assert.equal(document.querySelector('[class*="sortNote"]'), null);
    await act(async () => page.store.patchDataControls("Coins", { ...page.store.getSnapshot().data.controls.Coins, sort: "newest" }));
    await page.settle();
    assert.equal(document.querySelector('[class*="rankingNote"]'), null, "the pressed New list names the order without a narration line");
    assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="Discover coins"] button[aria-pressed="true"]')?.textContent, "New");
    assert.equal(document.querySelector('button[title="Filters"] [class*="badge"]')?.textContent, undefined);
  } finally {
    await page.dispose();
  }
});

test("Coins row shows stale truth, opens the coin on click and keeps Show independent", async () => {
  const page = await mounted(async () => Response.json({
    ...answer,
    coins: [{ ...coin, price_usd: null, price_as_of_ms: answer.clock_ms - 180_000 }],
  }));
  try {
    let row = document.querySelector<HTMLElement>("[data-workspace-row]")!;
    assert.equal(row.querySelector('[aria-label*="price availability"]'), null);
    assert.match(row.getAttribute("title")!, /^Stale price · observed .+ ago · No recent activity$/, "the stale price and why it is listed are the row's title");
    assert.match(row.textContent!, /Stale price · observed .+ ago · No recent activity/, "and its description for assistive technology");
    assert.equal(row.querySelector('[aria-label*="FDV availability"]'), null);
    assert.equal(row.querySelector('[aria-label="Top 10 holder share unavailable"]'), null);
    assert.match(row.textContent!, /No trades/, "an empty window names itself (live audit F30)");
    assert.equal(row.querySelector('[aria-label="Open KSTL in Focus"]')!.hasAttribute("aria-expanded"), false, "the row has no dropdown");
    await page.click("Open KSTL in Focus");
    const first = page.store.getSnapshot().visible_order[0]!;
    await page.click("Discover coins");
    await page.click("Open KSTL in Focus");
    await page.click("Discover coins");
    row = document.querySelector<HTMLElement>("[data-workspace-row]")!;
    assert.deepEqual(page.store.getSnapshot().visible_order, [first]);
    assert.equal(page.store.getSnapshot().focused_panel_id, first);
    assert.equal(row.querySelector("button[aria-label$=' in Focus']")!.hasAttribute("aria-expanded"), false);
    assert.equal(page.requests.some((url) => url.includes("/activity")), false);
    assert.equal(page.store.getSnapshot().data.controls.Coins.navigation.expanded_ids.length, 0);
  } finally {
    await page.dispose();
  }
});

test("Add opens a graduated sale in the existing coin namespace without losing its presale binding", async () => {
  const presaleId = `0x${"1".repeat(64)}`;
  const page = await mounted(async () =>
    Response.json({ ...answer, coins: [{ ...coin, presale_id: presaleId }] }),
  );
  try {
    await page.click("Open KSTL in Focus");
    const snapshot = page.store.getSnapshot();
    const panel = snapshot.panels[snapshot.visible_order[0]!]!;
    assert.equal(panel.presale_id, presaleId);
    assert.equal(panel.active_namespace, "coin");
  } finally {
    await page.dispose();
  }
});

const active: HomeCoin = { ...coin, coin_type: "0x2::coin::ACTV", symbol: "ACTV", name: "Active", rank: { score: 5, why: "Traded" } };
// Coin rows only: the ecosystem rows end with the way to all of them, which names no coin.
const listed = () => [...document.querySelectorAll('ol[aria-label*=" coins, "] > li')].flatMap((row) => row.querySelector("strong")?.textContent ?? []);

test("Trending lists ecosystem coins after the Blast coins with activity, half a page at most, and Add opens them", async () => {
  const urls: string[] = [];
  const page = await mounted(async (url) => { urls.push(url); return Response.json({ ...answer, coins: [active, coin], ranked: 1 }); });
  try {
    assert.ok(urls.length > 0 && urls.every((url) => new URL(url, "https://blast.test").searchParams.get("ranked") === "1"), "Trending asks for the count");
    assert.deepEqual(listed(), ["ACTV", "SUI", "USDC", "USDsui", "hashiBTC", "WAL", "KSTL"]);
    await page.click("Open WAL in Focus");
    const snapshot = page.store.getSnapshot();
    const panel = snapshot.panels[snapshot.visible_order[0]!]!;
    assert.equal(panel.coin_type, "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL");
    assert.equal(panel.presale_id, null);
    assert.equal(panel.active_namespace, "coin");
  } finally {
    await page.dispose();
  }
});

test("All ecosystem coins lists every curated coin a page at a time with fresh prices only, and Add opens USDsui", async () => {
  const { CORE_COINS } = await import("@blast/core/modules/social/portfolio/core-coins.ts");
  const usdsui = CORE_COINS.find((each) => each.symbol === "USDsui")!;
  const page = await mounted(async (url) => {
    const parsed = new URL(url, "https://blast.test");
    if (parsed.pathname !== "/api/social/prices") return Response.json({ ...answer, coins: [active, coin], ranked: 1 });
    const prices = parsed.searchParams.getAll("coin").filter((type) => type === usdsui.coinType).map((type) => ({
      presale_id: null, coin_type: type, tier: "5m", from_ms: Date.now() - 3_600_000, points: [], price_usd: "0.9998",
      price_24h_usd: null, change_24h_bps: null, day_open_usd: null, day_open_ms: null, price_as_of_ms: Date.now(),
    }));
    return Response.json({ window: "1h", clock_ms: Date.now(), as_of: answer.as_of, prices });
  });
  try {
    await page.click("All ecosystem coins");
    const region = () => document.querySelector<HTMLElement>('[role="region"][aria-label="Ecosystem coins"]');
    assert.equal(document.activeElement, region(), "the button left with the lead, so focus moves to the list it opened");
    assert.ok([...document.querySelectorAll("p")].some((note) => note.textContent === "Ecosystem coins"), "the list names itself while no tab is pressed");
    const rows = () => [...region()!.querySelectorAll("li")];
    assert.deepEqual(rows().map((row) => row.querySelector("strong")?.textContent), CORE_COINS.slice(0, 10).map((each) => each.symbol));
    const figure = (symbol: string) => rows().find((row) => row.querySelector("strong")?.textContent === symbol)!.textContent;
    assert.match(figure("USDsui"), /\$0\.9998/);
    assert.doesNotMatch(figure("WAL"), /\$/, "no market price, no figure");
    assert.ok(region()!.querySelector(`[aria-label="Page ${Math.ceil(CORE_COINS.length / 10)}"]`), "every coin is a page away");
    await page.click("Open USDsui in Focus");
    const snapshot = page.store.getSnapshot();
    assert.equal(snapshot.panels[snapshot.visible_order[0]!]!.coin_type, usdsui.coinType);
    await page.click("Trending");
    assert.equal(region(), null);
    assert.deepEqual(listed().slice(0, 2), ["ACTV", "SUI"]);
    // The Lists choice opens it too, and All goes back to the ranked list.
    await page.click("Ecosystem");
    assert.ok(region());
    await page.click("All");
    assert.equal(region(), null);
    assert.deepEqual(listed().slice(0, 2), ["ACTV", "SUI"]);
    // On Saved, All is the checked choice: picking it again keeps Saved, and leaving Ecosystem returns to Saved.
    const pressed = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]')].map((button) => button.textContent);
    await page.click("Saved");
    await page.click("All");
    assert.ok(pressed().includes("Saved"));
    await page.click("Ecosystem");
    await page.click("All");
    assert.equal(region(), null);
    assert.ok(pressed().includes("Saved"));
  } finally {
    await page.dispose();
  }
});

test("an added coin keeps its row's identity: a curated symbol, and a search result's ticker over its struct name", async () => {
  const zap = "0x" + "a".repeat(64) + "::meme::MEME";
  const page = await mounted(async (url) => new URL(url, "https://blast.test").pathname.endsWith("/trades/coins")
    ? Response.json({ coins: [{ coin_type: zap, symbol: "ZAP", name: "Zap", decimals: 9, icon_url: null, usd_price: null, presale_id: null }], next_cursor: null })
    : Response.json({ ...answer, coins: [active, coin], ranked: 1 }));
  try {
    // Hashi BTC's struct is `BTC` (as is suiWBTC's); the panel reads as hashiBTC before, and without, its own read.
    await page.click("Open hashiBTC in Focus");
    assert.ok(document.querySelector('[aria-label="Remove hashiBTC panel"]'));
    assert.equal(document.querySelector('[aria-label="Remove BTC panel"]'), null);
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search coins"]')!;
    // React loaded before this DOM existed, so it watches a text field's value from focus to keyup (its old-browser
    // path, which also calls attachEvent) rather than on `input`.
    Object.assign(search, { attachEvent() {}, detachEvent() {} });
    await act(async () => {
      search.focus();
      Object.getOwnPropertyDescriptor(page.dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "zap");
      search.dispatchEvent(new page.dom.window.KeyboardEvent("keyup", { bubbles: true }));
    });
    // The search reads once typing pauses.
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    await page.settle();
    await page.click("Open ZAP in Focus");
    assert.ok(document.querySelector('[aria-label="Remove ZAP panel"]'), "Add reports the row's ticker, not the struct name MEME");
  } finally {
    await page.dispose();
  }
});

test("a search answered 200 with no coins shows the empty state, never an error, and keeps the pills", async () => {
  const page = await mounted(async (url) => new URL(url, "https://blast.test").pathname.endsWith("/trades/coins")
    ? Response.json({ coins: [], next_cursor: null })
    : Response.json({ ...answer, coins: [active, coin], ranked: 1 }));
  try {
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search coins"]')!;
    Object.assign(search, { attachEvent() {}, detachEvent() {} });
    await act(async () => {
      search.focus();
      Object.getOwnPropertyDescriptor(page.dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "zzzz");
      search.dispatchEvent(new page.dom.window.KeyboardEvent("keyup", { bubbles: true }));
    });
    // The search reads once typing pauses.
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    await page.settle();
    const results = document.querySelector('[aria-label="Coin search results"]')!;
    assert.match(results.textContent ?? "", /Try a name, ticker or coin type\./);
    assert.doesNotMatch(results.textContent ?? "", /could not load|Retry/);
    const pills = document.querySelector('[role="group"][aria-label="Discover coins"]')!;
    assert.ok(pills, "the pills stay through the search");
    assert.equal(pills.querySelectorAll('[aria-pressed="true"]').length, 0, "search spans every source, so no pill reads as the shown list");
    await page.click("Trending");
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Search coins"]')!.value, "", "a pill leaves the search");
    assert.equal(document.querySelector('[aria-label="Coin search results"]'), null);
  } finally {
    await page.dispose();
  }
});

test("a held ranking keeps its ecosystem rows in place until Update ranking", async () => {
  let ranked = 1;
  const page = await mounted(async () => Response.json({ ...answer, coins: [active, coin], ranked }));
  try {
    await page.click("Live rankings");
    ranked = 2;
    await act(async () => { await page.client.refetchQueries(); });
    await page.settle();
    assert.deepEqual(listed(), ["ACTV", "SUI", "USDC", "USDsui", "hashiBTC", "WAL", "KSTL"], "no row moves under the pointer");
    await page.click("Update ranking");
    assert.deepEqual(listed(), ["ACTV", "KSTL", "SUI", "USDC", "USDsui", "hashiBTC", "WAL"]);
  } finally {
    await page.dispose();
  }
});

test("a pointer over the list holds its ecosystem rows in place until it leaves", async () => {
  let ranked = 1;
  const page = await mounted(async () => Response.json({ ...answer, coins: [active, coin], ranked }));
  try {
    const row = document.querySelector('ol[aria-label*=" coins, "] > li')!;
    await act(async () => { row.dispatchEvent(new page.dom.window.MouseEvent("pointerover", { bubbles: true })); });
    ranked = 2;
    await act(async () => { await page.client.refetchQueries(); });
    await page.settle();
    assert.deepEqual(listed(), ["ACTV", "SUI", "USDC", "USDsui", "hashiBTC", "WAL", "KSTL"], "no row moves under the pointer");
    await act(async () => { row.dispatchEvent(new page.dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })); });
    assert.deepEqual(listed(), ["ACTV", "KSTL", "SUI", "USDC", "USDsui", "hashiBTC", "WAL"]);
  } finally {
    await page.dispose();
  }
});

test("New lists ecosystem coins after every Blast coin, with or without a launch time, on the last page only", async () => {
  // 12 Blast coins, only 2 with a launch time (standalone vault coins have none): the ecosystem rows still follow all 12.
  const urls: URL[] = [];
  const page = await mounted(async (url) => {
    const parsed = new URL(url, "https://blast.test");
    urls.push(parsed);
    return Response.json({ ...answer, coins: [active, coin], total: 12, ranked: 2, page: Number(parsed.searchParams.get("page") ?? 1) });
  });
  try {
    await act(async () => page.store.patchDataControls("Coins", { ...page.store.getSnapshot().data.controls.Coins, sort: "newest" }));
    await page.settle();
    assert.deepEqual(listed(), ["ACTV", "KSTL"], "page 1 of 2 holds Blast coins only");
    assert.equal(urls.filter((url) => url.searchParams.get("sort") === "newest" && url.searchParams.has("ranked")).length, 0, "New does not ask for the count");
    await page.click("Next page");
    assert.deepEqual(listed(), ["ACTV", "KSTL", "SUI", "USDC", "USDsui", "hashiBTC", "WAL"]);
  } finally {
    await page.dispose();
  }
});

test("Coins stops an in-flight read when another Data view becomes active", async () => {
  let signal: AbortSignal | null | undefined;
  const page = await mounted(async (_url, current) => {
    signal = current;
    return new Promise((_resolve, reject) =>
      current?.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      }),
    );
  });
  try {
    assert.ok(document.querySelector('[aria-label="Loading coins"]'));
    assert.equal(signal?.aborted, false);
    await page.click("Traders");
    assert.equal(signal?.aborted, true);
    const count = page.requests.length;
    await page.settle();
    assert.equal(page.requests.length, count);
  } finally {
    await page.dispose();
  }
});

test("Coins preserves loaded rows through a refresh error and Retry recovers", async () => {
  let fail = false;
  const page = await mounted(async () =>
    fail
      ? Response.json({ error: "forbidden" }, { status: 403 })
      : Response.json(answer),
  );
  try {
    fail = true;
    await page.click("Refresh market prices");
    assert.match(document.body.textContent!, /Showing the previous result/);
    assert.ok(document.querySelector('[aria-label="Open KSTL in Focus"]'));
    fail = false;
    await page.click("Retry");
    assert.equal(document.querySelector('[role="alert"]'), null);
  } finally {
    await page.dispose();
  }
});

test("Coins restores the nearest saved row after results remove its anchor", async () => {
  let changed = false;
  const rows = [
    coin,
    { ...coin, coin_type: "0x3::coin::LUMN", symbol: "LUMN", name: "Lumen" },
  ];
  const page = await mounted(async () =>
    Response.json({ ...answer, coins: changed ? rows.slice(1) : rows }),
  );
  try {
    const body = document.getElementById("workspace-data-panel")!;
    const list = [
      ...body.querySelectorAll<HTMLElement>("[data-workspace-row]"),
    ];
    body.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    list[0]!.getBoundingClientRect = () =>
      ({ top: -12, bottom: 88 }) as DOMRect;
    list[1]!.getBoundingClientRect = () =>
      ({ top: 98, bottom: 198 }) as DOMRect;
    await act(async () => {
      body.scrollTop = 112;
      body.dispatchEvent(new page.dom.window.Event("scroll"));
    });
    assert.deepEqual(
      page.store.getSnapshot().data.controls.Coins.navigation.anchor,
      {
        coin_type: `0x${"2".padStart(64, "0")}::coin::KSTL`,
        index: 0,
        offset: -12,
      },
    );
    changed = true;
    await page.click("Refresh market prices");
    assert.equal(
      page.store.getSnapshot().data.controls.Coins.navigation.anchor?.coin_type,
      `0x${"3".padStart(64, "0")}::coin::LUMN`,
    );
    assert.equal(page.store.getSnapshot().data.controls.Coins.sort, "trending");
  } finally {
    await page.dispose();
  }
});

test("Coins keeps its filter disclosure in its setup and rows never write to it", async () => {
  const page = await mounted();
  try {
    await page.click("Filters");
    assert.deepEqual(page.store.getSnapshot().data.controls.Coins.navigation.expanded_ids, ["filters"]);
    await page.click("Close asset browser");
    await page.click("Discover coins");
    assert.equal(document.querySelector('button[title="Filters"]')?.getAttribute("aria-expanded"), "true");
    assert.equal(document.querySelector("[data-workspace-row] button[aria-label$=' in Focus']")!.hasAttribute("aria-expanded"), false);
  } finally {
    await page.dispose();
  }
});

test("Filters retains its controlled panel on pointer open and close while excluding closed controls", async () => {
  const page = await mounted();
  try {
    const button = document.querySelector<HTMLButtonElement>(
      'button[title="Filters"]',
    )!;
    const pointerClick = async () => {
      await act(async () => {
        button.dispatchEvent(
          new page.dom.window.MouseEvent("click", {
            bubbles: true,
            detail: 1,
          }),
        );
      });
      await page.settle();
    };
    const id = button.getAttribute("aria-controls")!;
    await pointerClick();
    const panel = document.getElementById(id)!;
    assert.ok(panel);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(panel.hasAttribute("inert"), false);
    assert.notEqual(panel.getAttribute("aria-hidden"), "true");
    assert.ok(panel.querySelector('[aria-label="Trades in the app only"]'));
    await pointerClick();
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(document.getElementById(id), panel);
    assert.equal(panel.getAttribute("aria-hidden"), "true");
    assert.equal(panel.hasAttribute("inert"), true);
    assert.equal(
      page.store
        .getSnapshot()
        .data.controls.Coins.navigation.expanded_ids.includes("filters"),
      false,
    );
    await pointerClick();
    assert.equal(document.getElementById(id), panel);
    assert.equal(panel.hasAttribute("inert"), false);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    // Following keeps the window (it applies to every source) but drops the Discover-only filters.
    await page.click("Following");
    assert.equal(document.getElementById(id), panel);
    assert.equal(panel.hasAttribute("inert"), false);
    assert.ok(panel.querySelector('button[aria-label^="Activity window:"]'));
    assert.equal(panel.querySelector('[aria-label="Trades in the app only"]'), null);
    assert.ok(
      page.store
        .getSnapshot()
        .data.controls.Coins.navigation.expanded_ids.includes("filters"),
    );
    await page.click("Discover");
    assert.equal(document.getElementById(id), panel);
    assert.equal(panel.hasAttribute("inert"), false);
    assert.ok(panel.querySelector('[aria-label="Trades in the app only"]'));
  } finally {
    await page.dispose();
  }
});

for (const input of ["keyboard", "reduced motion"] as const) {
  test(`Filters changes accessible state immediately for ${input}`, async () => {
    const page = await mounted(
      undefined,
      undefined,
      input === "reduced motion",
    );
    try {
      if (input === "keyboard")
        document.documentElement.dataset.blastInput = "keyboard";
      const button = document.querySelector<HTMLButtonElement>(
        'button[title="Filters"]',
      )!;
      const panel = document.getElementById(
        button.getAttribute("aria-controls")!,
      )!;
      assert.ok(panel);
      assert.equal(panel.hasAttribute("inert"), true);
      button.focus();
      await act(async () => button.click());
      assert.equal(button.getAttribute("aria-expanded"), "true");
      assert.equal(panel.hasAttribute("inert"), false);
      assert.notEqual(panel.getAttribute("aria-hidden"), "true");
      assert.equal(document.activeElement, button);
      await act(async () => button.click());
      assert.equal(button.getAttribute("aria-expanded"), "false");
      assert.equal(panel.hasAttribute("inert"), true);
      assert.equal(panel.getAttribute("aria-hidden"), "true");
      assert.equal(document.activeElement, button);
    } finally {
      await page.dispose();
    }
  });
}

test("authenticated Following uses the protected client with credentials and stops on leaving Coins", async () => {
  const protectedRequests: RequestInit[] = [];
  const page = await mounted(
    async (url, _signal, init) => {
      if (url === "/api/social/me/home/following") {
        protectedRequests.push(init!);
        return Response.json({ ...answer, mode: "coins", following: 1 });
      }
      return Response.json(answer);
    },
    {
      signedIn: true,
      callsign: "reader",
      getAccessToken: async () => "fixture-access-token",
    },
  );
  try {
    await page.click("Following");
    assert.match(document.body.textContent!, /KSTL/);
    assert.equal(protectedRequests.length, 1);
    assert.equal(
      new Headers(protectedRequests[0]!.headers).get("authorization"),
      "Bearer fixture-access-token",
    );
    assert.equal(protectedRequests[0]!.method, "POST");
    assert.deepEqual(JSON.parse(String(protectedRequests[0]!.body)), {
      mode: "coins",
      window: "24h",
      page: 1,
      limit: 10,
    });
    await page.click("Traders");
    await page.settle();
    assert.equal(protectedRequests.length, 1);
    assert.equal(page.store.getSnapshot().visible_order.length, 0);
  } finally {
    await page.dispose();
  }
});

test("a new page adopts its complete result even while rankings are paused", async () => {
  const next = { ...coin, symbol: "NEXT", coin_type: "0x3::coin::NEXT" };
  const page = await mounted(async (url) => {
    if (new URL(url, "https://blast.test").searchParams.get("page") === "2") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ ...answer, page: 2, coins: [next] });
    }
    return Response.json(answer);
  });
  try {
    await page.click("Live rankings");
    await page.click("Next page");
    await page.settle();
    assert.match(document.body.textContent!, /NEXT/);
    assert.doesNotMatch(document.body.textContent!, /KSTL/);
  } finally {
    await page.dispose();
  }
});

test("a covered Home observer cannot keep the Coins adapter's disposable request alive", async () => {
  let aborted = false;
  const page = await mounted(
    (_url, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  );
  const observer = new QueryObserver(page.client, {
    ...discoverQuery({ ...HOME_DEFAULT_QUERY, limit: 10 }),
    enabled: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await page.click("Traders");
    assert.equal(aborted, true);
  } finally {
    unsubscribe();
    await page.dispose();
  }
});

test("initial read errors retry into a confirmed result without adding a panel", async () => {
  let fail = true;
  const page = await mounted(async () =>
    fail
      ? Response.json({ error: { code: "forbidden" } }, { status: 403 })
      : Response.json({ ...answer, coins: [], pages: 1, total: 0 }),
  );
  try {
    assert.match(document.body.textContent!, /Coins could not load/);
    assert.doesNotMatch(document.body.textContent!, /No coins match/);
    fail = false;
    await page.click("Retry");
    // No Blast coin on the only page, so Trending lists just the ecosystem coins.
    assert.doesNotMatch(document.body.textContent!, /No coins to discover/);
    assert.ok(document.querySelector('button[aria-label="Open SUI in Focus"]'));
    assert.doesNotMatch(document.body.textContent!, /Coins could not load/);
    assert.equal(document.querySelectorAll('[data-workspace-row] [aria-label^="Add "]').length, 0);
    assert.equal(page.store.getSnapshot().visible_order.length, 0);
  } finally {
    await page.dispose();
  }
});

test("document visibility suspends Coins and returning refreshes it", async () => {
  const page = await mounted();
  try {
    const before = page.requests.length;
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new page.dom.window.Event("visibilitychange"));
    });
    await page.settle();
    assert.equal(document.querySelector('[aria-label="Open KSTL in Focus"]'), null);
    assert.equal(page.requests.length, before);
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new page.dom.window.Event("visibilitychange"));
    });
    await page.settle();
    assert.ok(document.querySelector('[aria-label="Open KSTL in Focus"]'));
    assert.ok(page.requests.length > before);
  } finally {
    await page.dispose();
  }
});

test("authenticated Watchlist loads scoped ids and public by-id facts only while shown", async () => {
  const presaleId = `0x${"123".padStart(64, "0")}`;
  const reads: { url: string; init?: RequestInit }[] = [];
  const page = await mounted(
    async (url, _signal, init) => {
      reads.push({ url, init });
      if (url === "/api/social/me/watchlist/keys")
        return Response.json({ keys: [presaleId] });
      if (url.startsWith("/api/social/home/coins"))
        return Response.json({
          ...answer,
          coins: [{ ...coin, presale_id: presaleId }],
          missing: [],
        });
      return Response.json(answer);
    },
    {
      signedIn: true,
      callsign: "reader",
      getAccessToken: async () => "fixture-access-token",
    },
  );
  try {
    await page.click("Saved");
    await page.settle();
    assert.match(document.body.textContent!, /KSTL/);
    assert.doesNotMatch(document.body.textContent!, /most recently saved/);
    const ids = reads.find(
      (read) => read.url === "/api/social/me/watchlist/keys",
    );
    assert.ok(ids);
    assert.equal(
      new Headers(ids.init?.headers).get("authorization"),
      "Bearer fixture-access-token",
    );
    assert.ok(
      reads.some(
        (read) =>
          read.url.startsWith("/api/social/home/coins") &&
          new URL(read.url, "https://blast.test").searchParams.get("presale") === presaleId,
      ),
    );
    assert.equal(page.store.getSnapshot().visible_order.length, 0);
    await page.click("Close asset browser");
    const count = reads.length;
    await page.settle();
    assert.equal(reads.length, count);
    await page.click("Discover coins");
    assert.ok(reads.length > count);
    assert.equal(
      reads.filter((read) => read.url === "/api/social/me/watchlist/keys")
        .length,
      1,
    );
  } finally {
    await page.dispose();
  }
});

test("Watchlist explains its first 50 saved assets and where to find the rest", async () => {
  const saved = Array.from(
    { length: 51 },
    (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`,
  );
  const requested: string[][] = [];
  const page = await mounted(
    async (url) => {
      if (url === "/api/social/me/watchlist/keys")
        return Response.json({ keys: saved });
      if (url.startsWith("/api/social/home/coins")) {
        requested.push(
          new URL(url, "https://blast.test").searchParams.getAll("presale"),
        );
        return Response.json({ ...answer, missing: [] });
      }
      return Response.json(answer);
    },
    {
      signedIn: true,
      callsign: "reader",
      getAccessToken: async () => "fixture-access-token",
    },
  );
  try {
    await page.click("Saved");
    await page.settle();
    assert.deepEqual(requested, [saved.slice(0, 50)]);
    assert.match(
      document.body.textContent!,
      /Showing your 50 most recently saved\. Older saved sales are on the presales page’s Watchlist\./,
    );
    assert.ok(document.querySelector('[aria-label="Open KSTL in Focus"]'));
    assert.equal(page.store.getSnapshot().visible_order.length, 0);
  } finally {
    await page.dispose();
  }
});

test("Watchlist empty wording covers only the first 50 when an available saved asset is beyond the limit", async () => {
  const saved = Array.from(
    { length: 51 },
    (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`,
  );
  const requested: string[][] = [];
  const page = await mounted(
    async (url) => {
      if (url === "/api/social/me/watchlist/keys")
        return Response.json({ keys: saved });
      if (url.startsWith("/api/social/home/coins")) {
        const ids = new URL(url, "https://blast.test").searchParams.getAll(
          "presale",
        );
        requested.push(ids);
        return Response.json({
          ...answer,
          coins: ids.includes(saved[50]!)
            ? [{ ...coin, presale_id: saved[50] }]
            : [],
          missing: ids.filter((id) => id !== saved[50]),
        });
      }
      return Response.json(answer);
    },
    {
      signedIn: true,
      callsign: "reader",
      getAccessToken: async () => "fixture-access-token",
    },
  );
  try {
    await page.click("Saved");
    await page.settle();
    assert.deepEqual(requested, [saved.slice(0, 50)]);
    assert.match(
      document.body.textContent!,
      /No available coins among your 50 most recently saved/,
    );
    assert.doesNotMatch(
      document.body.textContent!,
      /No available coins in your watchlist/,
    );
    assert.match(document.body.textContent!, /Older saved sales are on the presales/);
    assert.equal(document.querySelector('[aria-label="Open KSTL in Focus"]'), null);
  } finally {
    await page.dispose();
  }
});

test("Watchlist with exactly 50 saved assets has no coverage cap notice", async () => {
  const saved = Array.from(
    { length: 50 },
    (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`,
  );
  const page = await mounted(
    async (url) => {
      if (url === "/api/social/me/watchlist/keys")
        return Response.json({ keys: saved });
      if (url.startsWith("/api/social/home/coins"))
        return Response.json({ ...answer, coins: [], missing: saved });
      return Response.json(answer);
    },
    {
      signedIn: true,
      callsign: "reader",
      getAccessToken: async () => "fixture-access-token",
    },
  );
  try {
    await page.click("Saved");
    await page.settle();
    assert.match(
      document.body.textContent!,
      /No available coins in your watchlist/,
    );
    assert.doesNotMatch(document.body.textContent!, /most recently saved/);
  } finally {
    await page.dispose();
  }
});

test("legacy coin keys in saved disclosure state are ignored", async () => {
  const page = await mounted(async () => Response.json({ ...answer, coins: [coin, { ...coin, symbol: "LUMN", coin_type: "0x3::coin::LUMN" }] }));
  try {
    const keys = ["2", "3"].map(address => `0x${address.padStart(64, "0")}::coin::${address === "2" ? "KSTL" : "LUMN"}`);
    await act(async () => {
      const controls = page.store.getSnapshot().data.controls.Coins;
      page.store.patchDataControls("Coins", { ...controls, navigation: { ...controls.navigation, expanded_ids: ["filters", ...keys] } });
    });
    assert.equal(document.querySelectorAll("[data-workspace-row]").length, 2);
    assert.equal(document.querySelector("[data-workspace-row] button[aria-label$=' in Focus']")!.hasAttribute("aria-expanded"), false);
  } finally { await page.dispose(); }
});

test("focusing a market action preserves a scroll that has not yet emitted its scroll event", async () => {
  const page = await mounted();
  try {
    const body = document.getElementById("workspace-data-panel")!;
    const action = document.querySelector<HTMLButtonElement>('button[aria-label="Open KSTL in Focus"]')!;
    assert.ok(action);
    // Browsers can focus the pointer target before delivering the scroll event.
    body.scrollTop = 247;
    await act(async () => action.focus());
    assert.equal(body.scrollTop, 247, "focus must not replay the older saved position");
    await act(async () => action.click());
    assert.ok(page.store.getSnapshot().visible_order.length);
  } finally {
    await page.dispose();
  }
});

test("rows sharing a symbol name their venue and contract so the markets read apart (audit 08)", async () => {
  const twin = (digit: string, venue: string): HomeCoin => ({ ...coin, coin_type: `0x${digit.repeat(64)}::coin::KSTL`, venue });
  const page = await mounted(async () => Response.json({ ...answer, coins: [coin, twin("d", "cetus"), twin("b", "bluefin")], total: 3 }));
  try {
    const lines = [...document.querySelectorAll<HTMLElement>("[data-workspace-row]")].map((row) => row.textContent ?? "");
    assert.equal(lines.length, 3);
    assert.ok(lines.some((line) => line.includes("Bluefin") && line.includes("0xbbbb…bbbb")), "the Bluefin market by name and contract");
    assert.ok(lines.some((line) => line.includes("Cetus") && line.includes("0xdddd…dddd")), "the second Cetus market by its contract");
    // A symbol alone in the list keeps its compact line: the venue's mark and the volume.
    const bought = [{ quote_type: coin.quote.type, quote_symbol: coin.quote.symbol, quote_decimals: coin.quote.decimals, atoms: "1234000000", usd: "1234.00", usd_complete: false }];
    const single = await mounted(async () => Response.json({ ...answer, coins: [{ ...coin, activity: { ...coin.activity, bought } }] }));
    try {
      const row = document.querySelector<HTMLElement>("[data-workspace-row]")!;
      assert.doesNotMatch(row.textContent ?? "", /0x[0-9a-f]{4}…/, "no contract on a unique symbol");
      assert.match(row.textContent ?? "", /\$1\.2K\+ vol.*24h volume: \$1\.2K \(partial, tracked trades\)/);
      assert.equal(row.querySelector('button[aria-label*="Volume by activity"]'), null);
    } finally { await single.dispose(); }
  } finally {
    await page.dispose();
  }
});
