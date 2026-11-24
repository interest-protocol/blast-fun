import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";


import { queryKeys } from "#web/lib/query/keys.ts";
import type { SocialPriceHistory } from "@blast/core/modules/social/contracts/prices.ts";
import type { SocialSearchResponse } from "@blast/core/modules/social/contracts/search.ts";
import type { SocialTradeCoin } from "@blast/core/modules/social/contracts/trades.ts";



import type { SearchClient } from "./search-client";


const router = { push: () => undefined, replace: () => undefined, prefetch: () => undefined } as unknown as AppRouterInstance;
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
const { document, window } = installTestDom();
Object.assign(document, { oninput: null });
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { SUI_COIN_TYPE } = await import("@blast/core/lib/sui/coin-types.ts");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { SocialViewerProvider } = await import("../SignInGate");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ShellActionsProvider, useShellActions } = await import("#web/components/blast-ui/shell-actions.tsx");
const { SearchSheet } = await import("./SearchSheet");
const cleanup: (() => Promise<void>)[] = [];
const clients = new Set<ReturnType<typeof createTestQueryClient>>();
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); for (const client of clients) client.clear(); clients.clear(); });
function OpenSearch() {
  const run = useShellActions();
  return <button data-open-search type="button" onClick={() => run("openSearch")}>Open search</button>;
}
type SearchSetup = Readonly<{ client?: SearchClient; initialQuery?: string; initialRecents?: readonly string[]; initiallyOpen?: boolean }>;
const render = async (setup: SearchSetup, callsign: string | null = "kaimoreno", queries = createTestQueryClient({queries: {gcTime: 60_000}})) => {
  for (const close of cleanup.splice(0)) await close();
  clients.add(queries);
  const term = setup.initialQuery?.trim().toLowerCase() ?? "";
  const answer = setup.client?.remembered(term);
  if (answer) queries.setQueryData(queryKeys.search(term), answer);
  queries.setQueryData(queryKeys.search(""), setup.client?.remembered("") ?? {query: "", presales: [], people: [], as_of: AS_OF});
  queries.setQueryData([...queryKeys.search(""), "coins"], setup.client?.rememberedCoins("") ?? []);
  const coins = setup.client?.rememberedCoins(term);
  if (coins) queries.setQueryData([...queryKeys.search(term), "coins"], coins);
  window.localStorage.setItem("blast.recents", JSON.stringify(setup.initialRecents ?? []));
  const container = document.createElement("div"); container.setAttribute("data-blast-ui", ""); document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(withQueryClient(queries,
    <AppRouterContext value={router}><SocialViewerProvider callsign={callsign} signedIn={callsign !== null}>
      <ShellActionsProvider><OpenSearch /><SearchSheet /></ShellActionsProvider>
    </SocialViewerProvider></AppRouterContext>,
  )));
  if (setup.initiallyOpen) {
    await act(async () => container.querySelector<HTMLButtonElement>("[data-open-search]")!.click());
    if (setup.initialQuery) await act(async () => {
      const input = document.querySelector<HTMLInputElement>("[role=combobox]")!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, setup.initialQuery);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }
  return document.querySelector("[role=dialog]")?.outerHTML ?? "";
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const AS_OF = { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 };
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function client(answers: Readonly<Record<string, SocialSearchResponse>>, coins: Readonly<Record<string, readonly SocialTradeCoin[]>> = {}): SearchClient {
  return {
    failure: () => null,
    remembered: (raw) => answers[raw.trim().toLowerCase()] ?? null,
    search: async (raw) => answers[raw.trim().toLowerCase()] ?? null,
    rememberedCoins: (raw) => coins[raw.trim().toLowerCase()] ?? [],
    coins: async (raw) => coins[raw.trim().toLowerCase()] ?? [],
  };
}

const SUGGESTED: SocialSearchResponse = {
  query: "",
  presales: [
    { presale_id: hex(1), name: "Meridian", symbol: "MRDN", icon_url: "https://cdn.example/m.png", phase: "open" },
    { presale_id: hex(2), name: "Sable", symbol: "SABL", icon_url: "", phase: "pending" },
  ],
  people: [
    { callsign: "kaimoreno", display_name: "Kai Moreno", avatar_url: null, verified: true },
    { callsign: "blast", display_name: "Blast", avatar_url: null, verified: true },
    { callsign: "theopark", display_name: "Theo Park", avatar_url: null, verified: false },
  ],
  as_of: AS_OF,
};

test("Search announces its first pending results instead of showing an empty answer", async () => {
  const pending: SearchClient = {
    failure: () => null,
    remembered: () => null,
    rememberedCoins: () => null,
    search: async () => new Promise(() => {}),
    coins: async () => new Promise(() => {}),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  const html = await render({ client: pending, initiallyOpen: true, initialQuery: "meridian" });
  cleanup.push(async () => { globalThis.fetch = originalFetch; });
  assert.match(html, /aria-label="Loading results… Previous matches are shown\."/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /No results/);
  const list = document.querySelector('[role="listbox"]')!;
  assert.equal(list.hasAttribute("inert"), true, "previous results cannot be activated while pending");
  assert.match(document.querySelector('[role="status"]')?.textContent ?? "", /Previous matches/);
  assert.equal(document.querySelector('[role="combobox"]')?.hasAttribute("aria-activedescendant"), false);
  assert.equal(list.querySelector('[aria-selected="true"]'), null);
});

test("UI-12 (§12): the sheet: field, Esc, Recent, Presales and People rows, the first highlighted, the viewer left out", async () => {
  const html = await render({ client: client({ "": SUGGESTED }), initialRecents: ["Meridian", "luca"], initiallyOpen: true });
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /placeholder="Search coins, presales and people"/);
  assert.match(html, /aria-label="Search"/);
  assert.match(html, /role="combobox"/);
  assert.doesNotMatch(html, /<kbd>/); // no 11px key hint: Escape still closes
  // "S": the letter mark of a sale without an icon (OA-13).
  // OA-41: SUI leads Coins (no price read yet: its ticker alone, no move).
  assert.equal(text(html), "Search Recent Meridian luca Coins Sui SUI Presales Meridian MRDN · Live Sable SABL · Upcoming People Blast @blast Theo Park @theopark");
  // Exactly one highlighted option, the first; the field points at it.
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
  const first = /id="([^"]+-row-0)"/.exec(html)?.[1];
  assert.ok(first);
  assert.match(html, new RegExp(`aria-activedescendant="${first}"`));
  // Rows link where they go; the official account gets the helmet; verified people the rosette.
  assert.match(html, new RegExp(`href="/presale/${hex(1)}"`));
  assert.match(html, /href="\/@blast"/);
  assert.doesNotMatch(html, /href="\/@kaimoreno"/);
  assert.equal((html.match(/aria-label="Verified"/g) ?? []).length, 1);
  // A visitor sees everyone the server answered (up to five).
  assert.match(text(await render({ client: client({ "": SUGGESTED }), initiallyOpen: true }, null)), /People Kai Moreno @kaimoreno Blast @blast Theo Park/);
});

test("UI-12 (§12): a typed term hides Recent; no match says so; nothing renders while closed", async () => {
  const none: SocialSearchResponse = { query: "zzzz", presales: [], people: [], as_of: AS_OF };
  const html = await render({ client: client({ zzzz: none }), initialQuery: "ZZZZ", initialRecents: ["Meridian"], initiallyOpen: true });
  assert.equal(text(html), "Search No coins, presales or people match “zzzz”.");
  assert.doesNotMatch(html, /Coins/);
  assert.match(html, /value="ZZZZ"/);
  assert.match(html, /aria-label="Clear search"/);
  assert.equal(await render({ client: client({}) }), "");
});

const price = (presaleId: string | null, coinType: string, usd: string, bps: number | null): SocialPriceHistory => ({
  presale_id: presaleId, coin_type: coinType, tier: "5m", from_ms: 0, points: [], price_usd: usd, price_24h_usd: null, change_24h_bps: bps, day_open_usd: null, day_open_ms: null,
});

test("global search shows each presale once and keeps the coin price and move first", async () => {
  const nimbus: SocialTradeCoin = { coin_type: `${hex(11)}::nimb::NIMB`, symbol: "NIMB", name: "Nimbus", decimals: 9, icon_url: null, usd_price: "0.0031", presale_id: hex(11) };
  const kestrel: SocialTradeCoin = { ...nimbus, coin_type: `${hex(12)}::kstl::KSTL`, symbol: "KSTL", name: "Kestrel", usd_price: null, presale_id: hex(12) };
  const queries = createTestQueryClient({queries: {gcTime: 60_000}});
  queries.setQueryData(queryKeys.prices.history(`presale:${hex(11)}`, "24h"), price(hex(11), nimbus.coin_type, "0.0031", 3260));
  queries.setQueryData(queryKeys.prices.history(`presale:${hex(12)}`, "24h"), price(hex(12), kestrel.coin_type, "0.0021", -310));
  queries.setQueryData(queryKeys.prices.history(`coin:${SUI_COIN_TYPE}`, "24h"), price(null, SUI_COIN_TYPE, "3.42", 241));
  const typed: SocialSearchResponse = {
    query: "nim",
    presales: [
      { presale_id: hex(11), name: "Nimbus", symbol: "NIMB", icon_url: "", phase: "trading" },
      { presale_id: hex(13), name: "Nimbus", symbol: "NIMB", icon_url: "", phase: "open" },
    ],
    people: [],
    as_of: AS_OF,
  };
  const html = await render({ client: client({ nim: typed }, { nim: [nimbus] }), initialQuery: "nim", initiallyOpen: true }, "kaimoreno", queries);
  assert.deepEqual(
    Array.from(document.querySelectorAll('[role="option"]'), (row) => row.getAttribute("href")),
    [`/presale/${hex(11)}`, `/presale/${hex(13)}`],
  );
  assert.equal(text(html), "Search Coins Nimbus NIMB · $0.0031 +32.6% Presales Nimbus NIMB · Live");
  assert.match(html, /class="[^"]*chg[^"]* up"/);
  // The first row is highlighted and opens the presale page.
  assert.match(html, new RegExp(`<a[^>]*aria-selected="true"[^>]*href="/presale/${hex(11)}"[^>]*>`));
  // Nothing typed: SUI, then the first two sale coins; a falling coin reads down; SUI's round mark.
  const empty = await render({ client: client({ "": SUGGESTED }, { "": [nimbus, kestrel] }), initiallyOpen: true }, "kaimoreno", queries);
  assert.match(text(empty), /Coins Sui SUI · \$3\.42 \+2\.41% Nimbus NIMB · \$0\.0031 \+32\.6% Kestrel KSTL · \$0\.0021 −3\.1% Presales/);
  assert.match(empty, /class="[^"]*chg[^"]* down"/);
  assert.match(empty, /mk-sui/);
  // A coin matching hides the no-match line.
  const none: SocialSearchResponse = { query: "sui", presales: [], people: [], as_of: AS_OF };
  assert.equal(text(await render({ client: client({ sui: none }), initialQuery: "sui", initiallyOpen: true })), "Search Coins Sui SUI");
});


test("a failed coin search shows its safe diagnostic even when people and presales loaded", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes("/trades/coins")
    ? Response.json({ error: { code: "service_unavailable", message: "secret coin provider payload" } }, { status: 503, headers: { "X-Request-ID": "coin-search-213" } })
    : Response.json({ ...SUGGESTED, query: "codex" });
  try {
    await render({ initialQuery: "codex", initiallyOpen: true });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    const sheet = document.querySelector('[role="dialog"]')!;
    assert.match(sheet.textContent!, /Code: service_unavailable/);
    assert.match(sheet.textContent!, /Reference: coin-search-213/);
    assert.doesNotMatch(sheet.textContent!, /secret coin provider payload/);
    assert.match(sheet.textContent!, /Try again/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function typeSearch(value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>("[role=combobox]")!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

test("typing Joey or pasting its full coin type links to the same launch page", async () => {
  const coinType = "0xbcd73dc8d774982c2da4e07cd1c6803ec29e128821d1ade9e9a7ce4975b44944::joey::JOEY";
  const coin: SocialTradeCoin = {
    coin_type: coinType, name: "Joey", symbol: "JOEY", decimals: 9, icon_url: null, usd_price: null, presale_id: null, launch_id: hex(25),
  };
  const searchReads: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://blast.test");
    if (url.pathname === "/api/social/trades/coins" || url.pathname === "/api/social/search") {
      searchReads.push(url.pathname);
    }
    const term = url.searchParams.get("q");
    if (url.pathname === "/api/social/search") {
      return Response.json({ query: term, presales: [], people: [], as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 } });
    }
    if (url.pathname === "/api/social/trades/coins" && (term === "joey" || term === coinType) && url.searchParams.get("include_launch") === "1") {
      return Response.json({ coins: [coin], next_cursor: null });
    }
    return Response.json({});
  };
  try {
    await render({ initiallyOpen: true });
    await typeSearch("Joey");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    assert.equal(document.querySelector('[role="option"]')?.getAttribute("href"), `/coin/${encodeURIComponent(coinType)}`);
    assert.ok(searchReads.includes("/api/social/search"));
    searchReads.length = 0;

    await typeSearch(coinType);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    const options = [...document.querySelectorAll('[role="option"]')];
    assert.deepEqual(options.map((option) => option.textContent), ["JoeyJOEY"]);
    assert.equal(options[0]?.getAttribute("href"), `/coin/${encodeURIComponent(coinType)}`);
    assert.equal(document.querySelector('[role="dialog"] [role="alert"]'), null);
    assert.deepEqual(searchReads, ["/api/social/trades/coins"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retrying a failed coin-type lookup can confirm that the coin is missing", async () => {
  const originalFetch = globalThis.fetch;
  let lookups = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://blast.test");
    if (url.pathname === "/api/social/trades/coins" && url.searchParams.get("q") === `${hex(11)}::example::MISSING`) {
      lookups++;
      return lookups === 1
        ? Response.json({ error: { code: "service_unavailable" } }, { status: 503 })
        : Response.json({ coins: [], next_cursor: null });
    }
    return Response.json({});
  };
  try {
    await render({ initiallyOpen: true });
    await typeSearch("0xb::example::MISSING");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    const getSheet = () => document.querySelector('[role="dialog"]')!;
    const retry = [...getSheet().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Try again");
    assert.ok(retry);
    assert.ok(getSheet().querySelector('[role="alert"]'));
    await act(async () => retry.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    assert.equal(getSheet().querySelector('[role="alert"]'), null);
    assert.match(getSheet().textContent!, /No coin matches this type/);
    assert.equal(getSheet().querySelector('[role="option"]'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("equivalent edits keep settled matches ready for keyboard selection", async () => {
  const answer = { ...SUGGESTED, query: "nim", people: [] };
  await render({ client: client({ nim: answer }), initialQuery: "nim", initiallyOpen: true });
  const reads: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { reads.push(String(input)); return Response.json(answer); };
  try {
    await typeSearch("  $NIM  ");
    const input = document.querySelector<HTMLInputElement>("[role=combobox]")!;
    assert.ok(input.getAttribute("aria-activedescendant"), "normalization does not disable settled matches");
    assert.equal(document.querySelector('[role="listbox"]')!.hasAttribute("inert"), false);
    assert.equal(document.querySelector('[aria-label="Loading results… Previous matches are shown."]'), null);
    assert.deepEqual(reads, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rapid typing reads only the settled term and unmounting aborts both endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; signal: AbortSignal }[] = [];
  globalThis.fetch = (input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal);
    requests.push({ url: String(input), signal });
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    await render({ initiallyOpen: true });
    for (const term of ["n", "ni", "nim"]) await typeSearch(term);
    assert.equal(requests.length, 0, "nothing is read during the typing burst");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    assert.deepEqual(requests.map(({ url }) => url).sort(), ["/api/social/search?q=nim", "/api/social/trades/coins?q=nim&limit=5&include_launch=1"]);
    for (const close of cleanup.splice(0)) await close();
    assert.ok(requests.every(({ signal }) => signal.aborted));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("composing text waits for the completed word before searching", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/prices")) return Response.json({ prices: [] });
    // The test-sale lookup by id (lib/test-launches.ts) is not a search read.
    if (url.startsWith("/api/social/home/coins")) return Response.json({ coins: [], missing: [] });
    requests.push(url);
    return Response.json(url.includes("/trades/coins") ? { coins: [], next_cursor: null } : { ...SUGGESTED, query: "東京" });
  };
  try {
    await render({ initiallyOpen: true });
    const input = document.querySelector<HTMLInputElement>("[role=combobox]")!;
    await act(async () => { input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true })); });
    await typeSearch("東");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    assert.deepEqual(requests, [], "partial composition never reaches the API");
    await typeSearch("東京");
    await act(async () => { input.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "東京" })); });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    assert.deepEqual(requests.sort(), ["/api/social/search?q=%E6%9D%B1%E4%BA%AC", "/api/social/trades/coins?q=%E6%9D%B1%E4%BA%AC&limit=5&include_launch=1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
