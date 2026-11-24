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
  HomeThreadPage,
} from "@blast/core/modules/social/contracts/home.ts";
import { happeningPresale, happeningRead } from "../../../../../test/fixtures/social/happening/happening-fixtures.ts";
import { presaleId } from "../../../../../test/fixtures/workspace/presale-fixtures.ts";
import { createWorkspaceStore } from "./model";
import {
  encodeWorkspace,
  decodeWorkspace,
} from "@blast/core/modules/social/blast-workspace/codec.ts";
import { WorkspaceHost } from "./WorkspaceHost";
import { PresalesData } from "./PresalesData";
import { SocialViewerProvider, type SocialViewer } from "../../SignInGate";
import { WatchlistProvider } from "../../watchlist/Watchlist";

const totals: HomeThreadPage["totals"] = {
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
};

const coin: HomeCoin = {
  coin_type: "0x2::coin::KSTL",
  presale_id: presaleId,
  symbol: "KSTL",
  name: "Kestrel",
  icon_url: null,
  decimals: 9,
  lifecycle: "open",
  venue: "cetus",
  tradable: true,
  opened_ms: null,
  launched_ms: 1000,
  launch_id: null,
  quote: { type: "0x2::sui::SUI", symbol: "SUI", decimals: 9 },
  sale: {
    start_ms: 0,
    end_ms: Date.now() + 3_600_000,
    raised: "1000000000",
    raise_target: "10000000000",
    participants: 2,
  },
  price_usd: "0.00000000000000000012345",
  price_as_of_ms: Date.now(),
  change_24h_bps: null,
  holders: null,
  holders_as_of_ms: null,
  fdv_usd: null,
  spark: [],
  activity: { ...totals, preview: [] },
  discussion: { posts: 0 },
  top_holders: { holders: [], share_bps: null },
  rank: { score: 0, why: "No recent activity" },
};
const answer: HomeCoinsPage = {
  coins: [coin],
  page: 1,
  pages: 2,
  total: 11,
  next_cursor: null,
  window: "24h",
  clock_ms: Date.now(),
  as_of: { checkpoint: 1, timestamp_ms: Date.now(), lag_ms: 70_000 },
};

const happening = happeningRead({
  today: [happeningPresale({
    presale_id: presaleId,
    symbol: coin.symbol,
    name: coin.name,
    start_ms: coin.sale!.start_ms,
    end_ms: coin.sale!.end_ms,
  })],
  fastest: [],
  opening_soon: [],
  tape: [],
  last_hour: { wallets: 0, usd: "0.00" },
  clock_ms: answer.clock_ms,
  as_of: answer.as_of,
});
const activityThread = {
  presale_id: presaleId,
  participants: [],
  totals,
  next_cursor: null,
  window: answer.window,
  clock_ms: answer.clock_ms,
  as_of: answer.as_of,
};

async function mounted(
  read: (
    url: string,
    signal?: AbortSignal | null,
    init?: RequestInit,
  ) => Promise<Response> = async () => Response.json(happening),
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
    AbortController: dom.window.AbortController,
    AbortSignal: dom.window.AbortSignal,
    CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.matchMedia = (query) =>
    ({
      matches: reducedMotion && query.includes("prefers-reduced-motion"),
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const before = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push(String(input));
    return read(String(input), init?.signal, init);
  };
  const client = createTestQueryClient();
  const store = createWorkspaceStore();
  store.selectDataView("Presales");
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
                data: { Presales: PresalesData },
                panel: ({ panel }) => <p>{panel.coin_type}</p>,
              }}
            />
          </WatchlistProvider>
        </SocialViewerProvider>
      </QueryProvider>,
    );
  });
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }
  await settle();
  const click = async (label: string) => {
    if (label === "Close asset browser") label = "Collapse discovery";
    if (label === "Discover coins") label = "Expand discovery";
      if (["Coins", "Presales", "Traders", "Activity", "Feed", "Portfolio"].includes(label)) {
        await act(async () => store.selectDataView(label as Parameters<typeof store.selectDataView>[0]));
        await settle(); return;
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

test("public Presales discovery adds one canonical panel and preserves its draft on repeated Add", async () => {
  const page = await mounted(async (url) =>
    Response.json(
      url.startsWith("/api/social/happening")
        ? happening
        : { ...answer, missing: [] },
    ),
  );
  try {
    assert.ok(
      page.requests.some((url) => url.startsWith("/api/social/happening")),
    );
    assert.ok(
      page.requests.some((url) => url.startsWith("/api/social/home/coins")),
    );
    assert.ok(!page.requests.some((url) => url.includes("following")));
    assert.equal(page.store.getSnapshot().visible_order.length, 0);
    await page.click("Open KSTL in Focus");
    const first = page.store.getSnapshot().visible_order[0]!;
    const panel = page.store.getSnapshot().panels[first]!;
    assert.equal(panel.active_namespace, "presale");
    assert.equal(panel.presale_id, presaleId);
    await act(async () =>
      page.store.patchPanel(first, {
        presale: {
          ...panel.presale,
          commitment: {
            ...panel.presale.commitment,
            amount: "12.5",
            why: "My thesis",
          },
        },
      }),
    );
    assert.equal(document.querySelector('button[aria-label="Open KSTL in Focus"]')?.getAttribute("aria-current"), "true");
    await page.click("Open KSTL in Focus");
    assert.deepEqual(page.store.getSnapshot().visible_order, [first]);
    assert.equal(
      page.store.getSnapshot().panels[first]!.presale.commitment.amount,
      "12.5",
    );
    assert.equal(page.dom.window.location.search, "?sort=newest");
  } finally {
    await page.dispose();
  }
});

test("Presales row button name contains its visible symbol and opens the coin without expanding", async () => {
  const page = await mounted(async (url) => Response.json(
    url.startsWith("/api/social/happening") ? happening : { ...answer, missing: [] },
  ));
  try {
    const open = document.querySelector<HTMLButtonElement>('[aria-label="Open KSTL in Focus"]');
    assert.ok(open);
    // The whole row head is the control; its name starts with the row's visible symbol.
    const symbol = open.closest("[data-workspace-row]")!.querySelector("strong")!.textContent!.trim();
    assert.equal(symbol, "KSTL");
    assert.ok(open.getAttribute("aria-label")!.includes(symbol));
    assert.equal(open.hasAttribute("aria-expanded"), false);
    await page.click("Open KSTL in Focus");
    assert.equal(page.store.getSnapshot().visible_order.length, 1);
    assert.equal(page.requests.some((url) => url.includes("/activity")), false);
  } finally {
    await page.dispose();
  }
});

test("Presales price freshness follows the coin response clock across refresh", async () => {
  let clock = 1_700_000_000_000;
  const page = await mounted(async (url) =>
    Response.json(
      url.startsWith("/api/social/happening")
        ? { ...happening, clock_ms: 1_800_000_000_000 }
        : {
            ...answer,
            clock_ms: clock,
            coins: [{ ...coin, price_as_of_ms: 1_699_999_880_000 }],
            missing: [],
          },
    ),
  );
  try {
    assert.ok(document.querySelector('[aria-label="Open KSTL in Focus"]'));
    assert.doesNotMatch(document.body.textContent!, /Stale price/);
    clock = 1_700_000_000_001;
    await page.click("Refresh presales");
    assert.match(document.querySelector("[data-workspace-row]")!.getAttribute("title")!, /Stale price · observed .+ ago/);
    assert.equal(page.store.getSnapshot().visible_order.length, 0);
  } finally {
    await page.dispose();
  }
});

test("#588: a sale scheduled to open later reads as opening, not live, and lists no close", async () => {
  const start = Date.now() + 7_200_000;
  const scheduled = { ...coin, sale: { ...coin.sale!, start_ms: start, end_ms: start + 86_400_000, raised: "0" } };
  const page = await mounted(async (url) => Response.json(
    url.includes("/activity")
      ? activityThread
      : url.startsWith("/api/social/happening") ? happening : { ...answer, coins: [scheduled], missing: [] },
  ));
  try {
    const row = document.querySelector<HTMLElement>("[data-workspace-row]");
    assert.ok(row);
    assert.match(row.title, /^Opens /);
    assert.match(row.textContent!, /Not open yet/);
    assert.doesNotMatch(row.title + row.textContent!, /[Cc]loses/, "no close before it opens");
  } finally {
    await page.dispose();
  }
});

test("a sale whose coin read confirms it ended is not offered as eligible discovery", async () => {
  const page = await mounted(async (url) =>
    Response.json(
      url.startsWith("/api/social/happening")
        ? happening
        : { ...answer, coins: [{ ...coin, lifecycle: "funded" }], missing: [] },
    ),
  );
  try {
    assert.ok(
      !document.querySelector('[aria-label="Open KSTL in Focus"]'),
      "ended sales must not expose Add",
    );
    assert.match(document.body.textContent!, /No open presales/);
  } finally {
    await page.dispose();
  }
});

test("pending, failed initial reads, confirmed empty and failed refresh retain truthful distinct states", async () => {
  let release: (() => void) | undefined;
  let mode = "pending";
  const page = await mounted(async (url) => {
    if (mode === "pending")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (mode === "error") return Response.json({}, { status: 503 });
    return Response.json(
      url.startsWith("/api/social/happening")
        ? mode === "empty"
          ? { ...happening, today: [] }
          : happening
        : { ...answer, missing: [] },
    );
  });
  try {
    assert.ok(document.querySelector('[aria-label="Loading presales"]'));
    assert.doesNotMatch(document.body.textContent!, /No open presales/);
    mode = "error";
    await act(async () => release?.());
    await page.settle();
    assert.match(document.body.textContent!, /Presales could not load/);
    assert.doesNotMatch(document.body.textContent!, /No open presales/);
    mode = "empty";
    await page.click("Retry");
    assert.match(document.body.textContent!, /No open presales/);
    mode = "ready";
    await page.click("Refresh presales");
    assert.ok(document.querySelector('[aria-label="Open KSTL in Focus"]'));
    mode = "error";
    await page.click("Refresh presales");
    assert.match(
      document.body.textContent!,
      /could not refresh.*Showing the previous result/,
    );
    assert.ok(document.querySelector('[aria-label="Open KSTL in Focus"]'));
    assert.equal(page.store.getSnapshot().visible_order.length, 0);
  } finally {
    await page.dispose();
  }
});

test("Presales controls and anchor encode independently from Home and survive Data remounts", async () => {
  const page = await mounted(async (url) =>
    Response.json(
      url.startsWith("/api/social/happening")
        ? happening
        : { ...answer, missing: [] },
    ),
  );
  try {
    const controls = page.store.getSnapshot().data.controls.Presales;
    await act(async () =>
      page.store.patchDataControls("Presales", {
        ...controls,
        window: "1h",
        rows: 5,
        navigation: {
          scroll_top: 150,
          expanded_ids: ["saved-disclosure"],
          anchor: { coin_type: "0x2::coin::KSTL", index: 2, offset: -10 },
        },
      }),
    );
    await page.settle();
    await page.click("Close asset browser");
    const count = page.requests.length;
    await page.settle();
    assert.equal(page.requests.length, count);
    await page.click("Discover coins");
    assert.ok(page.requests.length > count);
    await page.click("Traders");
    const away = page.requests.length;
    await page.settle();
    assert.equal(page.requests.length, away);
    await page.click("Presales");
    assert.equal(page.store.getSnapshot().data.controls.Presales.window, "1h");
    assert.equal(page.store.getSnapshot().data.controls.Presales.rows, 5);
    assert.ok(page.requests.some((url) => url.includes("window=1h")));
    const saved = encodeWorkspace(page.store.getSnapshot());
    assert.ok(saved.ok);
    const restored = decodeWorkspace(saved.bytes);
    assert.ok(restored.ok);
    assert.deepEqual(
      restored.workspace.data.controls.Presales,
      page.store.getSnapshot().data.controls.Presales,
    );
    assert.equal(page.dom.window.location.search, "?sort=newest");
    // Controls live in the workspace; the device keeps only the Discover toggle's choice (Blast mode audit, pass C).
    // A browser also persists Discovery artwork for the collapsed rail.
    const storage = page.dom.window.localStorage;
    assert.ok(Object.keys(storage).every((key) => key === "blast.discover.chosen" || key.startsWith("blast.discovery-preview.")));
    assert.equal(page.dom.window.localStorage.getItem("blast.discover.chosen"), "1");
  } finally {
    await page.dispose();
  }
});

test("followed previews are actor-scoped and never requested for guests", async () => {
  const page = await mounted(
    async (url) =>
      Response.json(
        url.includes("following")
          ? {
              mode: "preview",
              window: answer.window,
              clock_ms: answer.clock_ms,
              previews: { [presaleId]: { ...coin.activity, participants: 7 } },
              as_of: answer.as_of,
            }
          : url.startsWith("/api/social/happening")
            ? happening
            : { ...answer, missing: [] },
      ),
    {
      signedIn: true,
      callsign: "reader",
      getAccessToken: async () => "fixture-token",
    },
  );
  try {
    assert.ok(page.requests.some((url) => url.includes("following")));
    assert.match(document.body.textContent!, /7 you follow/);
  } finally {
    await page.dispose();
  }
});

test("legacy Presales setup keeps exact saved fields and shared Coins anchors unchanged", () => {
  const store = createWorkspaceStore();
  const before = store.getSnapshot();
  assert.equal(Object.hasOwn(before.data.controls.Presales, "window"), false);
  const bytes = JSON.stringify(before);
  const restored = decodeWorkspace(bytes);
  assert.ok(restored.ok);
  assert.deepEqual(restored.workspace, before);
  assert.deepEqual(encodeWorkspace(restored.workspace), { ok: true, bytes });
  store.patchDataControls("Presales", {
    ...before.data.controls.Presales,
    window: "1h",
    page: 2,
    rows: 5,
  });
  assert.deepEqual(
    store.getSnapshot().data.controls.Coins,
    before.data.controls.Coins,
  );
});

test("closing Data cancels its unresolved public read and reopening refreshes it", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  let pending = true;
  const page = await mounted(async (url, signal) => {
    signals.push(signal);
    if (pending)
      return new Promise<Response>((_, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    return Response.json(
      url.startsWith("/api/social/happening")
        ? happening
        : { ...answer, missing: [] },
    );
  });
  try {
    await page.click("Close asset browser");
    assert.ok(signals[0]?.aborted);
    pending = false;
    await page.click("Discover coins");
    assert.ok(document.querySelector('[aria-label="Open KSTL in Focus"]'));
    assert.equal(page.store.getSnapshot().visible_order.length, 0);
  } finally {
    await page.dispose();
  }
});

test("collapsed Presales preserves its own list and opens the original presale namespace", async () => {
  const page = await mounted(async (url) => Response.json(url.startsWith("/api/social/happening") ? happening : { ...answer, missing: [] }));
  try {
    await page.click("Collapse discovery");
    assert.ok(document.querySelector('nav[aria-label="Presales shortcuts"]'));
    assert.ok(!document.querySelector('nav[aria-label="Coins shortcuts"]'));
    const reads = page.requests.length;
    await page.settle();
    assert.equal(page.requests.length, reads);
    await page.click("Open KSTL presale");
    const state = page.store.getSnapshot();
    const asset = state.panels[state.visible_order[0]!]!;
    assert.equal(asset.presale_id, presaleId);
    assert.equal(asset.active_namespace, "presale");
    assert.equal(state.data.collapsed, true);
    assert.equal(state.data.selected_view, "Presales");
    await page.click("Expand discovery");
    assert.equal(page.store.getSnapshot().data.selected_view, "Presales");
  } finally {
    await page.dispose();
  }
});
