import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceStore } from "./model";
import {
  encodeWorkspace,
  decodeWorkspace,
} from "@blast/core/modules/social/blast-workspace/codec.ts";

test("Activity restores its window, opaque traversal and event anchor independently of Home", () => {
  const store = createWorkspaceStore();
  store.patchDataControls("Activity", {
    window: "1h",
    kinds: [],
    page: 2,
    rows: 10,
    cursors: [null, "opaque:+/=2"],
    navigation: {
      scroll_top: 90,
      expanded_ids: [],
      anchor: { entry_id: "a:150:2:3:1", index: 2, offset: -8 },
    },
  });
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  const saved = decodeWorkspace(encoded.bytes);
  assert.ok(saved.ok);
  assert.equal(saved.workspace.data.controls.Activity.page, 2);
  assert.equal(
    saved.workspace.data.controls.Activity.cursors?.[1],
    "opaque:+/=2",
  );
  assert.equal(
    saved.workspace.data.controls.Activity.navigation.anchor?.entry_id,
    "a:150:2:3:1",
  );
  assert.equal(saved.workspace.data.controls.Coins.window, "24h");
});

import type {
  HomeActivityStreamPage,
  HomeActivityStreamEvent,
} from "@blast/core/modules/social/contracts/home.ts";
const { installTestDom } = await import(
  "../../../../../test/fixtures/social/test-dom.ts"
);
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { document, window } = installTestDom();
window.scrollTo = () => {};
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WorkspaceHost } = await import("./WorkspaceHost");
const now = 1792447200000;
const event = (
  patch: Partial<HomeActivityStreamEvent> = {},
): HomeActivityStreamEvent => ({
  activity_id: "150:2:3:1",
  entry_id: "a:150:2:3:1",
  kind: "trade_buy",
  occurred_at_ms: now - 60_000,
  digest: "digest",
  quote: {
    quote_type: "0x2::sui::SUI",
    quote_symbol: "SUI",
    quote_decimals: 9,
    atoms: "9007199254740993123",
    usd: null,
    usd_complete: false,
  },
  tokens: "1234567891",
  refund: null,
  has_why: false,
  actor: {
    type: "address",
    address: "0x" + "1".repeat(64),
    short: "0x1111…1111",
  },
  coin: {
    chain: "sui",
    network: "mainnet",
    coin_type: "0xc::coin::SOLO",
    presale_id: null,
    lifecycle: "migrated",
    decimals: 9,
    symbol: "SOLO",
    name: "Solo",
    icon_url: null,
  },
  ...patch,
});
const result = (
  events = [event()],
  next: string | null = "opaque-page-2",
): HomeActivityStreamPage => ({
  window: "24h",
  from_ms: now - 86_400_000,
  to_ms: now,
  clock_ms: now,
  events,
  next_cursor: next,
  as_of: { checkpoint: 1000, timestamp_ms: now, lag_ms: 70000 },
});
async function mounted(
  read?: (url: URL, init?: RequestInit) => Promise<Response>,
) {
  const { ActivityData } = await import("./ActivityData");
  document.body.innerHTML =
    '<div data-blast-ui><main id="main"></main><div id="mount"></div></div>';
  window.history.replaceState(null, "", "/?sort=newest");
  localStorage.setItem("blast.home.posts.rows", "20");
  const store = createWorkspaceStore();
  store.selectDataView("Activity");
  const client = createTestQueryClient();
  const root = createRoot(document.getElementById("mount")!);
  const before = globalThis.fetch;
  const requests: { url: URL; signal?: AbortSignal | null; method: string }[] =
    [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "https://blast.test");
    requests.push({ url, signal: init?.signal, method: init?.method ?? "GET" });
    return read ? read(url, init) : Response.json(result());
  };
  await act(async () =>
    root.render(
      <QueryProvider client={client}>
        <WorkspaceHost
          ownerKey="activity-reader"
          resolveOwner={async () => ({
            kind: "account",
            account_id: "reader",
            store,
          })}
          entryGeneration={1}
          onExit={() => {}}
          slots={{
            data: { Activity: ActivityData },
            panel: ({ panel }) => <p>{panel.coin_type}</p>,
          }}
        />
      </QueryProvider>,
    ),
  );
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  await settle();
  return {
    store,
    requests,
    settle,
    async click(label: string) {
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
    },
    async dispose() {
      await act(async () => root.unmount());
      client.clear();
      globalThis.fetch = before;
    },
  };
}

test("Activity Add reuses canonical standalone and presale panels without navigation, clearing drafts or sending", async () => {
  const sale = event({
    activity_id: "151:0:0:0",
    entry_id: "a:151:0:0:0",
    kind: "presale_commit",
    tokens: null,
    coin: {
      ...event().coin,
      coin_type: "0xb::coin::ORBIT",
      presale_id: "0x" + "b".padStart(64, "0"),
      lifecycle: "open",
      symbol: "ORBIT",
      name: "Orbit",
    },
  });
  const page = await mounted(async () =>
    Response.json(result([event(), sale])),
  );
  try {
    assert.equal(document.querySelectorAll("[data-workspace-event]").length, 2);
    assert.ok(
      document.querySelector(
        '[aria-label="Inspect full quote amount: 9007199254.740993123 SUI (9007199254740993123 atoms)"]',
      ),
    );
    assert.ok(
      document.querySelector(
        '[aria-label="Inspect full SOLO amount: 1.234567891 SOLO (1234567891 atoms)"]',
      ),
    );
    // Unpriced at the event: the row states the quote amount, never an invented dollar figure.
    const solo = document.querySelector<HTMLElement>('[data-workspace-event="a:150:2:3:1"]')!;
    assert.doesNotMatch(solo.textContent ?? "", /\$/);
    assert.match(solo.textContent ?? "", /bought/);
    assert.match(document.body.textContent ?? "", /Activity is delayed/);
    await page.click("Open SOLO in Focus");
    const coinId = page.store.getSnapshot().visible_order[0]!;
    const coin = page.store.getSnapshot().panels[coinId]!;
    await act(async () =>
      page.store.patchPanel(coinId, {
        coin: {
          ...coin.coin,
          trade: {
            ...coin.coin.trade,
            buy: { typed: "12.345678901", mode: "typed" },
          },
        },
      }),
    );
    await page.click("Open SOLO in Focus");
    assert.equal(
      page.store.getSnapshot().panels[coinId]!.coin.trade.buy.typed,
      "12.345678901",
    );
    await page.click("Open ORBIT in Focus");
    const saleId = Object.values(page.store.getSnapshot().panels).find(
      (panel) => panel.presale_id === sale.coin.presale_id,
    )!.panel_id;
    assert.equal(
      page.store.getSnapshot().panels[saleId]!.coin_type,
      "0x000000000000000000000000000000000000000000000000000000000000000b::coin::ORBIT",
    );
    const panel = page.store.getSnapshot().panels[saleId]!;
    await act(async () =>
      page.store.patchPanel(saleId, {
        presale: {
          ...panel.presale,
          commitment: {
            ...panel.presale.commitment,
            amount: "7.123456789",
            why: "Preserve this",
          },
        },
      }),
    );
    await page.click("Open ORBIT in Focus");
    assert.equal(Object.keys(page.store.getSnapshot().panels).length, 2);
    assert.equal(
      page.store.getSnapshot().panels[saleId]!.presale.commitment.amount,
      "7.123456789",
    );
    assert.equal(
      page.store.getSnapshot().panels[saleId]!.presale.commitment.why,
      "Preserve this",
    );
    assert.equal(window.location.search, "?sort=newest");
    assert.equal(localStorage.getItem("blast.home.posts.rows"), "20");
    assert.ok(page.requests.every((request) => request.method === "GET"));
  } finally {
    await page.dispose();
  }
});

test("Activity keeps rows on refresh error, restarts refused saved traversal and preserves a valid anchor", async () => {
  let failed = false;
  let expired = false;
  const page = await mounted(async (url) => {
    if (failed)
      return Response.json(
        { error: { code: "service_unavailable" } },
        { status: 503 },
      );
    if (expired && url.searchParams.has("cursor"))
      return Response.json(
        {
          error: {
            code: "invalid_parameter",
            parameter: "cursor",
            reason: "cursor_expired",
          },
        },
        { status: 400 },
      );
    return Response.json(
      result(
        url.searchParams.has("cursor")
          ? [event({ entry_id: "a:140:0:0:0", activity_id: "140:0:0:0" })]
          : [event()],
        url.searchParams.has("cursor") ? null : "opaque:+/=2",
      ),
    );
  });
  try {
    failed = true;
    await page.click("Refresh activity");
    assert.equal(document.querySelectorAll("[data-workspace-event]").length, 1);
    assert.match(
      document.body.textContent ?? "",
      /Showing the previous result/,
    );
    failed = false;
    await page.click("Retry");
    await page.click("Next page");
    assert.equal(page.store.getSnapshot().data.controls.Activity.page, 2);
    assert.equal(
      page.requests.at(-1)!.url.searchParams.get("cursor"),
      "opaque:+/=2",
    );
    await act(async () =>
      page.store.patchDataControls("Activity", {
        ...page.store.getSnapshot().data.controls.Activity,
        navigation: {
          scroll_top: 10,
          expanded_ids: [],
          anchor: { entry_id: "a:removed", index: 0, offset: -2 },
        },
      }),
    );
    expired = true;
    await page.click("Refresh activity");
    await page.settle();
    assert.equal(page.store.getSnapshot().data.controls.Activity.page, 1);
    assert.equal(
      page.store.getSnapshot().data.controls.Activity.navigation.anchor
        ?.entry_id,
      "a:150:2:3:1",
    );
    assert.match(document.body.textContent ?? "", /Activity restarted/);
    assert.deepEqual(page.store.getSnapshot().visible_order, []);
    assert.equal(window.location.search, "?sort=newest");
  } finally {
    await page.dispose();
  }
});

test("Activity only reads while active and visible, cancels disposable work and refreshes when shown", async () => {
  const page = await mounted();
  try {
    const count = page.requests.length;
    await act(async () => page.store.selectDataView("Coins"));
    await page.settle();
    assert.equal(page.requests.length, count);
    await act(async () => page.store.selectDataView("Activity"));
    await page.settle();
    assert.ok(page.requests.length > count);
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    const hidden = page.requests.length;
    await page.settle();
    assert.equal(page.requests.length, hidden);
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    await page.settle();
    assert.ok(page.requests.length > hidden);
    await page.click("Collapse discovery");
    const collapsed = page.requests.length;
    await page.settle();
    assert.equal(page.requests.length, collapsed);
    await page.click("Expand discovery");
    assert.ok(page.requests.length > collapsed);
  } finally {
    await page.dispose();
  }
});

test("Activity pending, read error and confirmed empty remain distinct", async () => {
  let release: (response: Response) => void = () => {};
  const page = await mounted(
    async (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  try {
    assert.ok(document.querySelector('[aria-label="Loading activity"]'));
    assert.doesNotMatch(document.body.textContent ?? "", /No activity in this window/);
    await act(async () => release(Response.json({}, { status: 503 })));
    await page.settle();
    assert.match(document.body.textContent ?? "", /Activity could not load/);
    assert.doesNotMatch(document.body.textContent ?? "", /No activity in this window/);
    await page.click("Retry");
    await act(async () => release(Response.json(result([], null))));
    await page.settle();
    assert.match(
      document.body.textContent ?? "",
      /No activity in this window/,
    );
  } finally {
    await page.dispose();
  }
});

test("a pending Activity request aborts when its Data view closes", async () => {
  const page = await mounted(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  try {
    const request = page.requests.at(-1)!;
    assert.equal(request.signal?.aborted, false);
    await page.click("Collapse discovery");
    assert.equal(request.signal?.aborted, true);
    assert.equal(
      document.querySelector('[aria-label="Loading activity"]'),
      null,
    );
  } finally {
    await page.dispose();
  }
});

test("Activity retains the displayed page when the next page fails and retries or returns without changing drafts", async () => {
  let failNext = true;
  let release: ((response: Response) => void) | undefined;
  const second = event({ entry_id: "a:140:0:0:0", activity_id: "140:0:0:0" });
  const page = await mounted(async (url) => {
    if (!url.searchParams.has("cursor")) return Response.json(result());
    if (failNext) return Response.json({}, { status: 503 });
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  try {
    await page.click("Open SOLO in Focus");
    const id = page.store.getSnapshot().visible_order[0]!;
    const panel = page.store.getSnapshot().panels[id]!;
    await act(async () =>
      page.store.patchPanel(id, {
        coin: {
          ...panel.coin,
          trade: {
            ...panel.coin.trade,
            buy: { typed: "12.345678901", mode: "typed" },
          },
        },
      }),
    );
    const panels = page.store.getSnapshot().panels;
    await page.click("Next page");
    assert.ok(document.querySelector('[data-workspace-event="a:150:2:3:1"]'));
    assert.match(
      document.body.textContent ?? "",
      /Page 2 could not load.*Showing page 1/,
    );
    assert.equal(
      (document.querySelector('[aria-label="Open SOLO in Focus"]') as HTMLButtonElement)
        .disabled,
      true,
    );
    assert.equal(page.store.getSnapshot().data.controls.Activity.page, 2);
    assert.ok(document.querySelector('[aria-label="Previous page"]'));
    failNext = false;
    await page.click("Retry");
    assert.ok(document.querySelector('[data-workspace-event="a:150:2:3:1"]'));
    assert.equal(
      (document.querySelector('[aria-label="Open SOLO in Focus"]') as HTMLButtonElement)
        .disabled,
      true,
    );
    await act(async () => release!(Response.json(result([second], null))));
    await page.settle();
    assert.ok(document.querySelector('[data-workspace-event="a:140:0:0:0"]'));
    assert.equal(
      (document.querySelector('[aria-label="Open SOLO in Focus"]') as HTMLButtonElement)
        .disabled,
      false,
    );
    await page.click("Previous page");
    assert.ok(document.querySelector('[data-workspace-event="a:150:2:3:1"]'));
    failNext = true;
    await page.click("Next page");
    await page.click("Previous page");
    assert.equal(page.store.getSnapshot().data.controls.Activity.page, 1);
    assert.ok(document.querySelector('[data-workspace-event="a:150:2:3:1"]'));
    assert.deepEqual(page.store.getSnapshot().panels, panels);
    assert.deepEqual(page.store.getSnapshot().visible_order, [id]);
    assert.ok(page.requests.every((request) => request.method === "GET"));
  } finally {
    await page.dispose();
  }
});

test("Activity names the pending target accessibly while showing the retained page through error and ready", async () => {
  let release: ((response: Response) => void) | undefined;
  const second = event({ entry_id: "a:140:0:0:0", activity_id: "140:0:0:0" });
  const page = await mounted(async (url) => {
    if (!url.searchParams.has("cursor")) return Response.json(result());
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  try {
    await page.click("Next page");
    assert.ok(
      document.querySelector(
        '[role="status"][aria-label="Loading activity page 2"]',
      ),
    );
    assert.equal(
      [...document.querySelectorAll('[role="status"]')].find((status) =>
        status.textContent?.includes("Showing page"),
      )?.textContent,
      "Showing page 1",
    );
    assert.ok(document.querySelector('[data-workspace-event="a:150:2:3:1"]'));
    assert.equal(
      (document.querySelector('[aria-label="Open SOLO in Focus"]') as HTMLButtonElement)
        .disabled,
      true,
    );
    await act(async () => release!(Response.json({}, { status: 503 })));
    await page.settle();
    assert.equal(
      document.querySelector('[aria-label="Loading activity page 2"]'),
      null,
    );
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /Page 2 could not load.*Showing page 1\./,
    );
    await page.click("Retry");
    assert.ok(
      document.querySelector(
        '[role="status"][aria-label="Loading activity page 2"]',
      ),
    );
    assert.equal(
      [...document.querySelectorAll('[role="status"]')].find((status) =>
        status.textContent?.includes("Showing page"),
      )?.textContent,
      "Showing page 1",
    );
    await act(async () => release!(Response.json(result([second], null))));
    await page.settle();
    assert.equal(
      document.querySelector('[aria-label="Loading activity page 2"]'),
      null,
    );
    assert.doesNotMatch(document.body.textContent ?? "", /Showing page 1/);
    assert.ok(document.querySelector('[data-workspace-event="a:140:0:0:0"]'));
    assert.equal(
      (document.querySelector('[aria-label="Open SOLO in Focus"]') as HTMLButtonElement)
        .disabled,
      false,
    );
  } finally {
    await page.dispose();
  }
});

test("a whale trade reads compact in its row and exact in the inspector (audit F34)", async () => {
  const whale = event({
    quote: { quote_type: "0x2::sui::SUI", quote_symbol: "SUI", quote_decimals: 9, atoms: "2000000000000000", usd: "1234567.89", usd_complete: true },
    tokens: "99312456789012345",
  });
  const unpriced = event({ activity_id: "150:2:3:2", entry_id: "a:150:2:3:2" });
  const page = await mounted(async () => Response.json(result([whale, unpriced], null)));
  try {
    const text = document.body.textContent ?? "";
    assert.match(text, /\$1\.23M/);
    assert.match(text, /99\.31M/);
    assert.match(text, /9\.01B SUI/);
    assert.doesNotMatch(text, /1,234,567\.89|99,312,456/);
  } finally {
    await page.dispose();
  }
});
