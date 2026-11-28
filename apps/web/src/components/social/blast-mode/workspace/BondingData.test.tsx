import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createWorkspaceStore } from "./model";

const { installTestDom } = await import("../../../../../test/fixtures/social/test-dom.ts");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { document, window } = installTestDom();
window.scrollTo = () => {};
const { act } = await import("react");
const { environmentManager } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { WorkspaceHost } = await import("./WorkspaceHost");
const { BondingData } = await import("./BondingData");
const { MarketStreamHub, resetTabMarketStream } = await import("#web/components/launchpad/market-stream-hub.ts");
type StreamListener = NonNullable<Parameters<InstanceType<typeof MarketStreamHub>["subscribe"]>[0]["listener"]>;

const provenance = { source: "blast-infra", network: "mainnet", deployment: "d", checkpoint: 7, timestampMs: 1, observedAt: 1, lagMs: 0 } as const;
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const HOUR = 3_600_000;

function row(tag: string, fields: Record<string, unknown> = {}) {
  const launchId = `0x${tag.padStart(64, "0")}`;
  return {
    launchId, coinType: `${launchId}::froggy::FROGGY`, quoteType: SUI, lifecycle: "live", name: "Froggy", symbol: "FROG", iconUrl: null,
    createdAtMs: Date.now() - 2 * HOUR, graduatedAtMs: null, quoteRemaining: "3500000000", quoteDecimals: 9, progressBps: 4250, partner: null,
    ...fields,
  };
}

type Answer = Record<string, unknown> | "error";

async function mounted(answers: (url: URL) => Answer, queries: Record<string, unknown> = {}, saved?: "graduated") {
  document.body.innerHTML = '<div data-blast-ui><main id="main"></main><div id="mount"></div></div>';
  const store = createWorkspaceStore();
  store.selectDataView("Bonding");
  if (saved) store.patchDataControls("Bonding", { ...store.getSnapshot().data.controls.Bonding, view: saved });
  const client = createTestQueryClient({ queries });
  const root = createRoot(document.getElementById("mount")!);
  const before = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://blast.test");
    if (url.pathname === "/api/social/health") return Response.json({ checkedAt: 1, backend: "healthy", sui: { status: "healthy", checkpoint: "1", timestampMs: 1 } });
    requests.push(url);
    const answer = answers(url);
    return answer === "error" ? new Response("unavailable", { status: 503 }) : Response.json(answer);
  };
  await act(async () =>
    root.render(
      <QueryProvider client={client}>
        <WorkspaceHost
          ownerKey="bonding"
          resolveOwner={async () => ({ kind: "account", account_id: "bonding", store })}
          entryGeneration={1}
          onExit={() => {}}
          slots={{ data: { Bonding: BondingData }, panel: ({ panel }) => <p>{panel.coin_type}</p> }}
        />
      </QueryProvider>,
    ),
  );
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  await settle();
  const panel = () => document.querySelector<HTMLElement>("#workspace-data-panel")!;
  return {
    store,
    requests,
    panel,
    async click(name: string) {
      const button = [...panel().querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === name || element.textContent === name);
      assert.ok(button, name);
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

const page = (view: string, rows: readonly unknown[], nextCursor: string | null = null) => ({ view, section: { state: "available", data: { rows, nextCursor }, provenance } });
/** The view an answer names: Almost graduated reads the bonding catalog by progress, which answers as `new`. */
const answerView = (url: URL) => url.searchParams.get("view") ?? "new";
/** Whether a read is Almost graduated's (the bonding catalog by progress). */
const almost = (url: URL) => url.searchParams.get("sort") === "progress";

test("Bonding lists a stage's curves as coin rows: progress and age, the missing ones left out with their row kept", async () => {
  const view = await mounted((url) => {
    if (almost(url)) return page(answerView(url), [row("b2", { progressBps: 9120, quoteRemaining: "880000000" })]);
    return page(answerView(url), [row("a1"), row("a2", { symbol: "QUIET", name: null, progressBps: null, quoteRemaining: null })]);
  });
  try {
    assert.equal(view.requests[0]!.pathname, "/api/launchpad/discovery");
    assert.equal(view.requests[0]!.searchParams.get("view"), "new");
    const rows = () => [...view.panel().querySelectorAll("ol li > div")];
    assert.equal(view.panel().querySelector("ol a"), null, "rows open the coin in the middle, never the coin's page");
    assert.equal(rows()[0]!.textContent, "FROGFroggy42.5% to graduationLaunched 2h ago");
    assert.equal(rows()[1]!.textContent, "QUIETLaunched 2h ago", "no progress, no name: the figures are omitted, never a dash");

    assert.equal(view.panel().querySelector('[aria-label="Curve stage"]')!.textContent, "NewAlmost graduated", "two stages, no Graduated");
    await view.click("Almost graduated");
    assert.equal(view.store.getSnapshot().data.controls.Bonding?.view, "near_graduation");
    assert.equal(view.requests.at(-1)!.search, "?catalog=bonding&sort=progress&q=&limit=10");
    assert.equal(rows()[0]!.textContent, "FROGFroggy91.2% to graduation0.88 SUI to go");
  } finally { await view.dispose(); }
});

test("Bonding: a click anywhere on a row opens its coin in the middle, by coin type, and marks the row open", async () => {
  const graduated = row("c3", { lifecycle: "migrated", graduatedAtMs: Date.now() - HOUR, symbol: "GRAD" });
  const view = await mounted((url) => page(answerView(url), [row("a1"), graduated]));
  try {
    const button = () => view.panel().querySelector<HTMLButtonElement>('button[aria-label="Open FROG"]')!;
    assert.equal(button().hasAttribute("aria-current"), false);
    await view.click("Open FROG");
    const snapshot = view.store.getSnapshot();
    assert.equal(snapshot.visible_order.length, 1);
    const panel = snapshot.panels[snapshot.visible_order[0]!]!;
    assert.equal(panel.coin_type, row("a1").coinType);
    assert.equal(panel.presale_id, null);
    assert.equal(panel.active_namespace, "coin", "the coin view: chart and buy");
    assert.equal(button().getAttribute("aria-current"), "true");
    assert.equal(location.pathname, "/", "Blast mode stays put");

    await view.click("Open GRAD");
    const after = view.store.getSnapshot();
    assert.ok(after.visible_order.some((id) => after.panels[id]!.coin_type === graduated.coinType && after.panels[id]!.active_namespace === "coin"));
  } finally { await view.dispose(); }
});

test("Bonding: an empty stage says so after its read; a failed read offers Retry; a next page reads its cursor", async () => {
  let failing = true;
  const view = await mounted((url) => {
    const stage = answerView(url);
    if (almost(url)) return failing ? "error" : page(stage, [row("d4", { progressBps: 9000 })]);
    return url.searchParams.get("cursor") === "page-2" ? page(stage, [row("e6", { symbol: "NEXT" })]) : page(stage, [row("e5")], "page-2");
  });
  try {
    assert.match(view.panel().querySelector('nav[aria-label="Pages of bonding curves"]')!.textContent!, /Page 1/, "an unknown total reads as the page number");
    await view.click("Next page");
    assert.equal(view.requests.at(-1)!.searchParams.get("cursor"), "page-2");
    assert.match(view.panel().textContent!, /NEXT/);

    await view.click("Almost graduated");
    const alert = view.panel().querySelector('[role="alert"]');
    assert.match(alert?.textContent ?? "", /Bonding curves couldn’t load/);
    failing = false;
    await view.click("Retry");
    assert.equal(view.panel().querySelector('[role="alert"]'), null);
    assert.equal(view.panel().querySelectorAll("ol li").length, 1);
  } finally { await view.dispose(); }
});

test("Bonding keeps the confirmed empty result and offers Retry if a refresh fails", async () => {
  let failing = false;
  const view = await mounted((url) => failing ? "error" : almost(url) ? page(answerView(url), [row("d4", { progressBps: 9000 })]) : { view: answerView(url), section: { state: "empty", provenance } }, { gcTime: 60_000 });
  try {
    assert.match(view.panel().textContent!, /No bonding curves yet/);
    assert.equal(view.panel().querySelector('[aria-label="Refresh bonding curves"]'), null, "no refresh button: choosing a stage reads it again");
    await view.click("Almost graduated");
    assert.match(view.panel().textContent!, /90% to graduation/);
    failing = true;
    await view.click("New");
    assert.match(view.panel().textContent!, /No bonding curves yet/);
    assert.match(view.panel().querySelector('[role="alert"]')?.textContent ?? "", /couldn’t refresh/);
    failing = false;
    await view.click("Retry");
    assert.equal(view.panel().querySelector('[role="alert"]'), null);
    assert.match(view.panel().textContent!, /No bonding curves yet/);
  } finally { await view.dispose(); }
});

test("Bonding: with no curve at 60%, Almost graduated leaves the switch and the rail shows New, keeping the saved stage", async () => {
  const view = await mounted((url) => almost(url) ? { view: answerView(url), section: { state: "empty", provenance } } : page(answerView(url), [row("a1", { progressBps: 2800 })]));
  try {
    await view.click("Almost graduated");
    assert.equal(view.panel().querySelector('[aria-label="Curve stage"]')!.textContent, "New", "no empty stage on offer");
    assert.equal(view.panel().querySelector('[aria-pressed="true"]')?.textContent, "New");
    assert.match(view.panel().textContent!, /FROGFroggy28% to graduation/, "the 28% curve shows under New");
    assert.doesNotMatch(view.panel().textContent!, /almost graduated/i);
    assert.equal(view.store.getSnapshot().data.controls.Bonding?.view, "near_graduation", "the saved stage comes back with its first curve");
  } finally { await view.dispose(); }
});

test("Bonding: with the stream down, a hidden Almost graduated comes back with its first curve", async () => {
  // Query loaded before the test DOM, so it took this for a server and would schedule no refetch timer.
  const wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
  mock.timers.enable({ apis: ["setInterval"] });
  let near: readonly unknown[] = [];
  const view = await mounted((url) => almost(url) ? (near.length ? page(answerView(url), near) : { view: answerView(url), section: { state: "empty", provenance } }) : page(answerView(url), [row("a1", { progressBps: 2800 })]));
  try {
    await view.click("Almost graduated");
    assert.equal(view.panel().querySelector('[aria-label="Curve stage"]')!.textContent, "New");
    near = [row("b2", { progressBps: 6100 })];
    await act(async () => mock.timers.tick(36_000));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
    assert.equal(view.panel().querySelector('[aria-label="Curve stage"]')!.textContent, "NewAlmost graduated", "back at the fallback pace");
    assert.equal(view.panel().querySelector('[aria-pressed="true"]')?.textContent, "Almost graduated", "the saved stage shows again");
  } finally {
    await view.dispose();
    mock.timers.reset();
    environmentManager.setIsServer(() => wasServer);
  }
});

test("Bonding: a stage the stream emptied comes back by HTTP once the stream drops", async (t) => {
  const wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
  const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { value: class {}, configurable: true, writable: true });
  let listener: StreamListener | undefined;
  t.mock.method(MarketStreamHub.prototype, "subscribe", (request: { listener: StreamListener }) => {
    listener = request.listener;
    return { stop() {} };
  });
  // The stream's empty page is older than what HTTP reads after the drop.
  const later = { ...provenance, checkpoint: 8 };
  const view = await mounted((url) => almost(url)
    ? { view: answerView(url), section: { state: "available", data: { rows: [row("b2", { progressBps: 6100 })], nextCursor: null }, provenance: later } }
    : page(answerView(url), [row("a1", { progressBps: 2800 })]));
  try {
    assert.ok(listener, "the rail listens to the stream");
    await act(async () => {
      listener!.state("live");
      listener!.discovery?.({ view: "near_graduation", section: { state: "empty", provenance } } as never);
    });
    assert.equal(view.panel().querySelector('[aria-label="Curve stage"]')!.textContent, "New", "the stream emptied Almost graduated");
    assert.equal(view.requests.filter(almost).length, 0, "no HTTP read of it while the stream is live");
    await act(async () => listener!.state("recovering"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
    assert.equal(view.panel().querySelector('[aria-label="Curve stage"]')!.textContent, "NewAlmost graduated", "read by HTTP once the stream drops");
  } finally {
    await view.dispose();
    resetTabMarketStream();
    if (original) Object.defineProperty(globalThis, "WebSocket", original);
    else Reflect.deleteProperty(globalThis, "WebSocket");
    environmentManager.setIsServer(() => wasServer);
  }
});

test("Bonding opens a setup saved on the retired Graduated stage on New", async () => {
  const ui = await mounted((url) => page(answerView(url), [row("1")]), {}, "graduated");
  try {
    assert.deepEqual(ui.requests.map((url) => url.searchParams.get("view")), ["new"]);
    assert.equal(ui.panel().querySelector('[aria-pressed="true"]')?.textContent, "New");
  } finally {
    await ui.dispose();
  }
});
