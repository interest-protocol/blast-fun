import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceStore } from "./model";
import {
  decodeWorkspace,
  encodeWorkspace,
} from "@blast/core/modules/social/blast-workspace/codec.ts";

test("Feed saves opaque page navigation and post inspection independently of Home", () => {
  const store = createWorkspaceStore();
  store.patchDataControls("Feed", {
    tab: "for_you",
    page: 2,
    rows: 10,
    cursors: [null, "eyJ2IjoxLCJyYW5rIjoxfQ"],
    navigation: {
      scroll_top: 120,
      expanded_ids: ["a:5000:1:0:0"],
      anchor: { entry_id: "a:5000:1:0:0", index: 2, offset: -8 },
    },
  });
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  const saved = decodeWorkspace(encoded.bytes);
  assert.ok(saved.ok);
  assert.deepEqual(saved.workspace.data.controls.Feed, {
    tab: "for_you",
    page: 2,
    rows: 10,
    cursors: [null, "eyJ2IjoxLCJyYW5rIjoxfQ"],
    navigation: {
      scroll_top: 120,
      expanded_ids: ["a:5000:1:0:0"],
      anchor: { entry_id: "a:5000:1:0:0", index: 2, offset: -8 },
    },
  });
  assert.equal(saved.workspace.data.controls.Coins.navigation.scroll_top, 0);
});

const { installTestDom, testEvent } = await import(
  "../../../../../test/fixtures/social/test-dom.ts"
);
const { feedItem, feedPage, FIXTURE_NOW } = await import(
  "../../../../../test/fixtures/social/feed-fixtures.ts"
);
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { document, window } = installTestDom();

window.scrollTo = () => {};
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WorkspaceHost } = await import("./WorkspaceHost");

const FIXTURE_AS_OF = {
  checkpoint: 1,
  timestamp_ms: FIXTURE_NOW,
  lag_ms: 0,
};

/** A by-ID coins answer that satisfies the shared response contract. */
function coinsAnswer(coins: readonly unknown[] = []) {
  return {
    coins,
    missing: [],
    window: "24h",
    clock_ms: FIXTURE_NOW,
    as_of: FIXTURE_AS_OF,
  };
}

function mrdnCoin() {
  return {
    presale_id: feedItem().presale!.presale_id,
    coin_type: "0x2::coin::MRDN",
    symbol: "MRDN",
    name: "Meridian",
    icon_url: null,
    decimals: 9,
    lifecycle: "open",
    venue: "presale",
    tradable: false,
    opened_ms: null,
    launched_ms: null,
    launch_id: null,
    quote: { type: "0x2::sui::SUI", symbol: "SUI", decimals: 9 },
    price_usd: null,
    price_as_of_ms: null,
    change_24h_bps: null,
    spark: [],
    holders: null,
    holders_as_of_ms: null,
    fdv_usd: null,
    activity: {
      scope: "pool",
      window: "24h",
      from_ms: 0,
      to_ms: FIXTURE_NOW,
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
    rank: { score: 0, why: "No recent activity" },
    sale: null,
    top_holders: { holders: [], share_bps: null },
  };
}

async function mounted(
  read?: (url: URL, init?: RequestInit) => Promise<Response>,
) {
  const { FeedData } = await import("./FeedData");
  document.body.innerHTML =
    '<div data-blast-ui><main id="main"></main><div id="mount"></div></div>';
  window.history.replaceState(null, "", "/?sort=newest");
  localStorage.setItem("blast.home.posts.rows", "20");
  const store = createWorkspaceStore();
  // New workspaces start with Feed hidden; these tests exercise it, so turn it on first.
  store.setDataViewEnabled("Feed", true);
  store.selectDataView("Feed");
  const client = createTestQueryClient();
  const root = createRoot(document.getElementById("mount")!);
  const before = globalThis.fetch;
  const requests: { url: URL; signal?: AbortSignal | null; method: string }[] =
    [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "https://blast.test");
    requests.push({ url, signal: init?.signal, method: init?.method ?? "GET" });
    if (read) return read(url, init);
    if (url.pathname.endsWith("/coins"))
      return Response.json(coinsAnswer([mrdnCoin()]));
    return Response.json(
      feedPage({
        items: [
          feedItem({ pinned: true }),
          feedItem({
            entry_id: "a:4900:1:0:0",
            kind: "presale_claim",
            why: null,
          }),
          feedItem({
            entry_id: "a:4800:1:0:0",
            kind: "future_kind",
            presale: null,
          }),
        ],
        next_cursor: "opaque-page-2",
      }),
    );
  };
  await act(async () =>
    root.render(
      <QueryProvider client={client}>
        <WorkspaceHost
          ownerKey="reader"
          resolveOwner={async () => ({
            kind: "account",
            account_id: "reader",
            store,
          })}
          entryGeneration={1}
          onExit={() => {}}
          slots={{
            data: { Feed: FeedData },
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
    },
    async dispose() {
      await act(async () => root.unmount());
      client.clear();
      globalThis.fetch = before;
    },
  };
}

test("Feed keeps ranked mixed rows, inspects in place, and Add reuses a canonical asset without clearing drafts", async () => {
  const page = await mounted();
  try {
    assert.deepEqual(
      [...document.querySelectorAll("[data-workspace-post]")].map((row) =>
        row.getAttribute("data-workspace-post"),
      ),
      ["a:5000:1:0:0", "a:4900:1:0:0", "a:4800:1:0:0"],
    );
    assert.match(document.body.textContent ?? "", /Pinned by Blast/);
    assert.match(document.body.textContent ?? "", /claim/i);
    await page.click("Read post a:5000:1:0:0");
    assert.ok(document.querySelector('[role="dialog"][aria-labelledby]'));
    assert.ok(document.querySelector('[data-entry-id="a:5000:1:0:0"]'));
    assert.ok(
      document.querySelector('[data-gated="sign-in"]'),
      "existing post actions retain their visitor gate",
    );
    assert.equal(page.store.getSnapshot().visible_order.length, 0);
    await page.click("Close");
    await page.click("Open MRDN in Focus");
    const id = page.store.getSnapshot().visible_order[0]!;
    const panel = page.store.getSnapshot().panels[id]!;
    await act(async () =>
      page.store.patchPanel(id, {
        presale: {
          ...panel.presale,
          commitment: { ...panel.presale.commitment, amount: "123.456789" },
        },
      }),
    );
    await page.click("Open MRDN in Focus");
    assert.deepEqual(page.store.getSnapshot().visible_order, [id]);
    assert.equal(
      page.store.getSnapshot().panels[id]!.presale.commitment.amount,
      "123.456789",
    );
    assert.equal(window.location.search, "?sort=newest");
    assert.equal(localStorage.getItem("blast.home.posts.rows"), "20");
    assert.ok(page.requests.every((request) => request.method === "GET"));
  } finally {
    await page.dispose();
  }
});

test("Feed restores opaque pages and the nearest surviving anchor while preserving rows after a refresh failure", async () => {
  let failed = false;
  const page = await mounted(async (url) => {
    if (url.pathname.endsWith("/coins"))
      return Response.json(coinsAnswer());
    if (failed) return Response.json({}, { status: 503 });
    return Response.json(
      feedPage({
        items: url.searchParams.has("cursor")
          ? [feedItem({ entry_id: "a:4000:1:0:0" })]
          : [feedItem()],
        next_cursor: url.searchParams.has("cursor") ? null : "opaque:+/=page2",
        as_of: { checkpoint: 1, timestamp_ms: FIXTURE_NOW, lag_ms: 70000 },
      }),
    );
  });
  try {
    await page.click("Next page");
    assert.match(
      document.querySelector('[aria-label="Posts"]')?.innerHTML ?? "",
      /a:4000:1:0:0/,
    );
    assert.equal(
      page.requests
        .filter((request) => request.url.pathname.endsWith("/feed"))
        .at(-1)!
        .url.searchParams.get("cursor"),
      "opaque:+/=page2",
    );
    await act(async () =>
      page.store.patchDataControls("Feed", {
        ...page.store.getSnapshot().data.controls.Feed,
        navigation: {
          scroll_top: 120,
          expanded_ids: [],
          anchor: { entry_id: "removed", index: 99, offset: -8 },
        },
      }),
    );
    assert.deepEqual(
      page.store.getSnapshot().data.controls.Feed.navigation.anchor,
      { entry_id: "a:4000:1:0:0", index: 0, offset: -8 },
    );
    await act(async () => page.store.selectDataView("Coins"));
    await act(async () => page.store.selectDataView("Feed"));
    await page.settle();
    assert.equal(page.store.getSnapshot().data.controls.Feed.page, 2);
    assert.match(document.body.textContent ?? "", /Activity is delayed/);
    failed = true;
    await page.click("Refresh posts");
    assert.match(
      document.body.textContent ?? "",
      /Showing the previous result/,
    );
    assert.equal(document.querySelectorAll("[data-workspace-post]").length, 1);
    assert.ok(!document.body.textContent?.includes("No posts yet"));
    failed = false;
    await page.click("Retry");
    assert.ok(!document.querySelector('[role="alert"]'));
    assert.equal(window.location.search, "?sort=newest");
  } finally {
    await page.dispose();
  }
});

test("Feed pending reads stop when Data closes, another view opens, or the document hides and refresh on return", async () => {
  let pending = true;
  const page = await mounted(async (url, init) => {
    if (!pending)
      return Response.json(feedPage({ items: [], next_cursor: null }));
    return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      ),
    );
  });
  try {
    assert.ok(document.querySelector('[aria-label="Loading posts"]'));
    assert.ok(!document.body.textContent?.includes("No posts yet"));
    const first = page.requests.at(-1)!;
    await act(async () => page.store.setDataCollapsed(true));
    assert.equal(first.signal?.aborted, true);
    const count = page.requests.length;
    await page.settle();
    assert.equal(page.requests.length, count);
    await act(async () => page.store.setDataCollapsed(false));
    await page.settle();
    const second = page.requests.at(-1)!;
    await act(async () => page.store.selectDataView("Coins"));
    assert.equal(second.signal?.aborted, true);
    await act(async () => page.store.selectDataView("Feed"));
    await page.settle();
    const third = page.requests.at(-1)!;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () =>
      document.dispatchEvent(testEvent("visibilitychange")),
    );
    assert.equal(third.signal?.aborted, true);
    pending = false;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () =>
      document.dispatchEvent(testEvent("visibilitychange")),
    );
    await page.settle();
    assert.match(document.body.textContent ?? "", /No posts yet/);
  } finally {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await page.dispose();
  }
});

test("a failed first Feed read offers retry without claiming empty and a successful empty answer stays distinct", async () => {
  let failed = true;
  const page = await mounted(async () =>
    failed
      ? Response.json({}, { status: 503 })
      : Response.json(feedPage({ items: [], next_cursor: null })),
  );
  try {
    assert.match(document.body.textContent ?? "", /Posts could not load/);
    assert.ok(!document.body.textContent?.includes("No posts yet"));
    failed = false;
    await page.click("Retry");
    assert.match(document.body.textContent ?? "", /No posts yet/);
    assert.ok(!document.querySelector('[role="alert"]'));
  } finally {
    await page.dispose();
  }
});

test("Feed revisits a learned later page with its saved opaque cursor", async () => {
  const page = await mounted(async (url) => {
    if (!url.pathname.endsWith("/feed"))
      return Response.json(coinsAnswer());
    const cursor = url.searchParams.get("cursor");
    const number = cursor === null ? 1 : cursor === "opaque-2" ? 2 : 3;
    return Response.json(
      feedPage({
        items: [feedItem({ entry_id: `a:${5000 - number}:1:0:0` })],
        next_cursor:
          number === 1 ? "opaque-2" : number === 2 ? "opaque-3" : null,
      }),
    );
  });
  try {
    await page.click("Next page");
    await page.click("Next page");
    await page.click("Page 1");
    await page.click("Page 3");
    assert.equal(
      document
        .querySelector("[data-workspace-post]")
        ?.getAttribute("data-workspace-post"),
      "a:4997:1:0:0",
    );
    assert.deepEqual(page.store.getSnapshot().data.controls.Feed.cursors, [
      null,
      "opaque-2",
      "opaque-3",
    ]);
  } finally {
    await page.dispose();
  }
});
