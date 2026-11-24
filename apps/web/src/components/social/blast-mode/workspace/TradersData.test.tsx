import assert from "node:assert/strict";
import test from "node:test";
import { fixtureMarket } from "../../../../../test/fixtures/presale-pages/market-fixtures.ts";
import { presaleId } from "../../../../../test/fixtures/workspace/presale-fixtures.ts";
import { createWorkspaceStore } from "./model";
import {
  decodeWorkspace,
  encodeWorkspace,
} from "@blast/core/modules/social/blast-workspace/codec.ts";
import {
  installTestDom,
  setInputValue,
  testEvent,
} from "../../../../../test/fixtures/social/test-dom.ts";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import type {
  HomeTrader,
  HomeTradersPage,
} from "@blast/core/modules/social/contracts/home.ts";

const { document, window } = installTestDom();
window.scrollTo = () => {};
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WorkspaceHost } = await import("./WorkspaceHost");
const { TradersData } = await import("./TradersData");

const asOf = { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 };
const traders: HomeTrader[] = Array.from({ length: 125 }, (_, index) => ({
  key: `c:trader${index}`,
  rank: index + 1,
  actor: {
    type: "account",
    callsign: `trader${index}`,
    display_name: `Trader ${index}`,
    path: `/@trader${index}`,
    avatar_url: null,
    x_handle: null,
    verified: false,
  },
  followers: null,
  buys: null,
  sells: null,
  commits: null,
  claims: null,
  latest_ms: 0,
  latest_kind: "trade_buy",
  events_total: 0,
  coins: [],
  coins_total: 0,
  holdings: [],
  portfolio: { public: true, value_usd: "0.00", pnl_usd: `${125 - index}.00` },
}));
function answer(url: URL): HomeTradersPage {
  const search = url.searchParams.get("search") ?? "";
  const page = Number(url.searchParams.get("page") ?? 1);
  const limit = Number(url.searchParams.get("limit") ?? 5);
  const filtered = traders.filter((row) => row.key.includes(search));
  return {
    search,
    page,
    limit,
    total: filtered.length,
    global_total: 125,
    window: "24h",
    clock_ms: 1,
    as_of: asOf,
    traders: filtered.slice((page - 1) * limit, page * limit),
  };
}
async function mounted(
  read: (url: URL, init?: RequestInit) => Promise<Response> = async (url) =>
    Response.json(answer(url)),
) {
  document.body.innerHTML =
    '<div data-blast-ui><main id="main"></main><div id="mount"></div></div>';
  window.history.replaceState(null, "", "/?sort=newest");
  const store = createWorkspaceStore();
  store.selectDataView("Traders");
  const client = createTestQueryClient();
  const root = createRoot(document.getElementById("mount")!);
  const before = globalThis.fetch;
  const requests: { url: URL; signal: AbortSignal | null | undefined }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "https://blast.test");
    requests.push({ url, signal: init?.signal });
    return read(url, init);
  };
  const render = () =>
    root.render(
      <QueryProvider client={client}>
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
            data: { Traders: TradersData },
            panel: ({ panel }) => <p>{panel.coin_type}</p>,
          }}
        />
      </QueryProvider>,
    );
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
  await act(async () => render());
  await settle();
  const click = async (label: string) => {
      const tab=["Coins","Presales","Traders","Activity","Feed","Portfolio"].includes(label) ? document.querySelector<HTMLButtonElement>(`[role="tablist"][aria-label="What to discover"] #workspace-data-tab-${label}[role="tab"]`) : null;
      if(tab) {
        await act(async()=>tab.click());
        await settle();return;
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
  const edit = async (text: string) => {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(
        'input[type="search"]',
      )!;
      setInputValue(input, text);
      input.dispatchEvent(testEvent("input"));
    });
  };
  const search = async (text: string) => {
    await edit(text);
    await act(async () =>
      document
        .querySelector('form[role="search"]')!
        .dispatchEvent(testEvent("submit")),
    );
    await settle();
  };
  return {
    store,
    client,
    root,
    requests,
    render,
    settle,
    click,
    edit,
    search,
    async dispose() {
      await act(async () => root.unmount());
      client.clear();
      globalThis.fetch = before;
    },
  };
}

test("Traders navigation saves an actor anchor independently of coin navigation", () => {
  const store = createWorkspaceStore();
  store.patchDataControls("Traders", {
    ...store.getSnapshot().data.controls.Traders,
    navigation: {
      scroll_top: 120,
      expanded_ids: ["c:maya"],
      anchor: { actor_key: "c:maya", index: 2, offset: -8 },
    },
  });
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  const saved = decodeWorkspace(encoded.bytes);
  assert.ok(saved.ok);
  assert.deepEqual(saved.workspace.data.controls.Traders.navigation, {
    scroll_top: 120,
    expanded_ids: ["c:maya"],
    anchor: { actor_key: "c:maya", index: 2, offset: -8 },
  });
  assert.equal(saved.workspace.data.controls.Coins.navigation.scroll_top, 0);
});

test("only resolved canonical holdings can Add, promoting the same asset without changing saved drafts", async () => {
  const holding = {
    presale_id: presaleId,
    symbol: "KSTL",
    icon_url: null,
    decimals: 9,
    balance: "1",
    value_usd: null,
    share_bps: null,
    pnl_usd: null,
  };
  const page = await mounted(async (url) =>
    Response.json(
      url.pathname.endsWith("/coins")
        ? {
            coins: [
              {
                ...fixtureMarket(0),
                presale_id: presaleId,
                coin_type: "0x2::coin::KSTL",
                symbol: "KSTL",
                lifecycle: "migrated",
              },
            ],
            missing: [],
            window: "24h",
            clock_ms: 1,
            as_of: asOf,
          }
        : { ...answer(url), traders: [{ ...traders[0], holdings: [holding] }] },
    ),
  );
  try {
    assert.ok(!document.querySelector('[aria-label="Open KSTL in Focus"]'));
    await page.click("Trader 0 holdings");
    assert.doesNotMatch(document.body.textContent ?? "", /Fresh valuation unavailable|Performance unavailable/);
    const holdingRow = document.querySelector('[aria-label="Inspect full KSTL balance in atoms: 1"]')!.closest("li")!;
    assert.equal(holdingRow.querySelector("dt"), null, "unknown optional metrics omit their labels too");
    assert.ok(
      document.querySelector(
        '[aria-label="Inspect full KSTL balance in atoms: 1"]',
      ),
    );
    await page.click("Open KSTL in Focus");
    const id = page.store.getSnapshot().visible_order[0]!;
    const panel = page.store.getSnapshot().panels[id]!;
    assert.equal(panel.active_namespace, "coin");
    assert.equal(panel.presale_id, presaleId);
    await act(async () =>
      page.store.patchPanel(id, {
        coin: {
          ...panel.coin,
          trade: {
            ...panel.coin.trade,
            sell: { typed: "0.000000001", mode: "typed" },
          },
        },
      }),
    );
    await page.click("Open KSTL in Focus");
    assert.deepEqual(page.store.getSnapshot().visible_order, [id]);
    assert.equal(
      page.store.getSnapshot().panels[id]!.coin.trade.sell.typed,
      "0.000000001",
    );
    assert.equal(window.location.search, "?sort=newest");
    assert.ok(
      page.requests.every(({ url }) => !url.pathname.includes("transaction")),
    );
  } finally {
    await page.dispose();
  }
});

test("holdings keep tiny balances visibly nonzero and inspection copies exact atoms", async () => {
  const balances = [
    { symbol: "ONE", balance: "1", text: "<0.0001 ONE" },
    { symbol: "BELOW", balance: "49999", text: "<0.0001 BELOW" },
    { symbol: "HALF", balance: "50000", text: "0.0001 HALF" },
    { symbol: "ZERO", balance: "0", text: "0 ZERO" },
    { symbol: "NORMAL", balance: "1234567890000", text: "1,234.5679 NORMAL" },
  ];
  const page = await mounted(async (url) =>
    Response.json(
      url.pathname.endsWith("/coins")
        ? { coins: [], missing: [], window: "24h", clock_ms: 1, as_of: asOf }
        : {
            ...answer(url),
            traders: [{
              ...traders[0],
              holdings: balances.map(({ symbol, balance }) => ({
                presale_id: symbol,
                symbol,
                balance,
                decimals: 9,
                icon_url: null,
                value_usd: null,
                share_bps: null,
                pnl_usd: null,
              })),
            }],
          },
    ),
  );
  const copied: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { copied.push(value); } },
  });
  try {
    await page.click("Trader 0 holdings");
    for (const { symbol, balance, text } of balances) {
      const label = `Inspect full ${symbol} balance in atoms: ${balance}`;
      assert.equal(
        document.querySelector(`[aria-label="${label}"]`)?.textContent,
        text,
      );
      await page.click(label);
      assert.equal(
        document.querySelector(`[aria-label="Full ${symbol} balance in atoms"] code`)?.textContent,
        balance,
      );
      await page.click(`Copy full ${symbol} balance in atoms`);
      assert.equal(copied.at(-1), balance);
      assert.ok(document.body.textContent?.includes("Copied"));
      await page.click("Close");
    }
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    await page.dispose();
  }
});

test("Data Traders searches and pages global PnL without changing Home or creating trader panels", async () => {
  const page = await mounted();
  try {
    assert.match(document.body.textContent ?? "", /125 traders ranked/);
    await page.click("Page 4");
    assert.match(document.body.textContent ?? "", /Trader 15/);
    assert.equal(
      document
        .querySelector("[data-workspace-trader]")
        ?.getAttribute("data-workspace-trader"),
      "c:trader15",
    );
    await page.search("trader124");
    assert.match(document.body.textContent ?? "", /1 trader found · Ranks are global/);
    assert.match(document.body.textContent ?? "", /Rank 125/);
    await page.click("Trader 124 holdings");
    await page.edit("unsent draft");
    await act(async () => page.store.selectDataView("Activity"));
    await act(async () => page.store.selectDataView("Traders"));
    await page.settle();
    assert.equal(
      document.querySelector<HTMLInputElement>('input[type="search"]')?.value,
      "unsent draft",
    );
    assert.equal(
      document
        .querySelector('[aria-label="Trader 124 holdings"]')
        ?.getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(page.store.getSnapshot().visible_order.length, 0);
    assert.equal(window.location.search, "?sort=newest");
    // The name opens the trader's profile page (leaving Blast mode); it never creates a panel.
    assert.ok(document.querySelector('a[href="/@trader124"]'));
    assert.ok(
      page.requests
        .filter(({ url }) => url.pathname === "/api/social/home/traders")
        .every(({ url }) => url.searchParams.get("window") === "24h"),
    );
    await page.search("no-match");
    assert.match(document.body.textContent ?? "", /No matching traders/);
  } finally {
    await page.dispose();
  }
});

test("private holdings stay private, unresolved assets cannot Add, and missing performance is excluded", async () => {
  const privateHolding = {
    presale_id: "private-sale",
    symbol: "SECRET",
    icon_url: null,
    decimals: 9,
    balance: "999",
    value_usd: "99.00",
    share_bps: 10000,
    pnl_usd: "99.00",
  };
  const page = await mounted(async (url) =>
    Response.json({
      ...answer(url),
      traders: [
        {
          ...traders[0],
          holdings_public: false,
          holdings: [privateHolding],
          portfolio: { public: true, value_usd: "99.00", pnl_usd: "12.00" },
        },
        {
          ...traders[1],
          portfolio: { public: false, value_usd: "888.00", pnl_usd: "777.00" },
        },
        {
          ...traders[2],
          portfolio: { public: true, value_usd: null, pnl_usd: null },
        },
      ],
    }),
  );
  try {
    await page.click("Trader 0 holdings");
    assert.match(document.body.textContent ?? "", /Private/);
    assert.ok(!document.body.textContent?.includes("SECRET"));
    assert.ok(!document.body.textContent?.includes("Trader 1"));
    assert.ok(!document.body.textContent?.includes("Trader 2"));
    assert.ok(
      !page.requests.some(({ url }) => url.pathname.endsWith("/coins")),
    );
    assert.ok(!document.querySelector('[data-workspace-trader] [aria-label^="Add "]'));
  } finally {
    await page.dispose();
  }
});

test("refresh errors retain loaded rows and retry recovers without confusing errors with confirmed empty", async () => {
  let mode = "ready";
  const page = await mounted(async (url) =>
    mode === "error"
      ? Response.json({}, { status: 503 })
      : Response.json({
          ...answer(url),
          as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 70_000 },
        }),
  );
  try {
    assert.match(document.body.textContent ?? "", /Activity is delayed/);
    mode = "error";
    await page.click("Refresh traders");
    assert.match(
      document.body.textContent ?? "",
      /could not refresh.*Showing the previous result/,
    );
    assert.match(document.body.textContent ?? "", /Trader 0/);
    assert.ok(!document.body.textContent?.includes("No traders"));
    mode = "ready";
    await page.click("Retry");
    assert.ok(!document.querySelector('[role="alert"]'));
  } finally {
    await page.dispose();
  }
});

test("closing Data or hiding the document aborts its pending read and showing it refreshes", async () => {
  let pending = true;
  const page = await mounted(async (url, init) => {
    if (!pending || url.pathname !== "/api/social/home/traders")
      return Response.json(answer(url));
    return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      ),
    );
  });
  try {
    assert.ok(document.querySelector('[aria-label="Loading traders"]'));
    const first = page.requests.find(({ url }) =>
      url.pathname.endsWith("/traders"),
    )!;
    await act(async () => page.store.setDataCollapsed(true));
    assert.equal(first.signal?.aborted, true);
    const count = page.requests.length;
    await page.settle();
    assert.equal(page.requests.length, count);
    pending = false;
    await act(async () => page.store.setDataCollapsed(false));
    await page.settle();
    assert.match(document.body.textContent ?? "", /Trader 0/);
    pending = true;
    await page.click("Refresh traders");
    const last = page.requests
      .filter(({ url }) => url.pathname.endsWith("/traders"))
      .at(-1)!;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () =>
      document.dispatchEvent(testEvent("visibilitychange")),
    );
    assert.equal(last.signal?.aborted, true);
    pending = false;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () =>
      document.dispatchEvent(testEvent("visibilitychange")),
    );
    await page.settle();
    assert.match(document.body.textContent ?? "", /Trader 0/);
  } finally {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await page.dispose();
  }
});

test("an absent saved trader anchor falls back to the nearest available row", async () => {
  const page = await mounted();
  try {
    await act(async () =>
      page.store.patchDataControls("Traders", {
        ...page.store.getSnapshot().data.controls.Traders,
        navigation: {
          scroll_top: 120,
          expanded_ids: [],
          anchor: { actor_key: "c:removed", index: 99, offset: -8 },
        },
      }),
    );
    await page.settle();
    assert.deepEqual(
      page.store.getSnapshot().data.controls.Traders.navigation.anchor,
      { actor_key: "c:trader4", index: 4, offset: -8 },
    );
    assert.equal(
      page.store.getSnapshot().data.controls.Coins.navigation.scroll_top,
      0,
    );
  } finally {
    await page.dispose();
  }
});

test("closing expanded holdings cancels their canonical asset read and reopening refreshes", async () => {
  let resolveAssets = false;
  const page = await mounted(async (url, init) => {
    if (!url.pathname.endsWith("/coins"))
      return Response.json({
        ...answer(url),
        traders: [
          {
            ...traders[0],
            coins: [{
              presale_id: presaleId, symbol: "KSTL", icon_url: null, decimals: 9,
              buys: null, sells: null, commits: null, claims: null, latest_ms: 1,
            }],
          },
        ],
      });
    if (resolveAssets)
      return Response.json({
        coins: [],
        missing: [presaleId],
        window: "24h", clock_ms: 1, as_of: asOf,
      });
    return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      ),
    );
  });
  try {
    await page.click("Trader 0 holdings");
    const first = page.requests.find(({ url }) =>
      url.pathname.endsWith("/coins"),
    )!;
    assert.ok(first);
    await page.click("Trader 0 holdings");
    assert.equal(first.signal?.aborted, true);
    const count = page.requests.filter(({ url }) =>
      url.pathname.endsWith("/coins"),
    ).length;
    await page.settle();
    assert.equal(
      page.requests.filter(({ url }) => url.pathname.endsWith("/coins")).length,
      count,
    );
    resolveAssets = true;
    await page.click("Trader 0 holdings");
    assert.equal(
      page.requests.filter(({ url }) => url.pathname.endsWith("/coins")).length,
      count + 1,
    );
    assert.ok(!document.querySelector('[aria-label="Open KSTL in Focus"]'));
  } finally {
    await page.dispose();
  }
});
