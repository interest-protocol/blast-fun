import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceStore } from "./model";

const { installTestDom } = await import("../../../../../test/fixtures/social/test-dom.ts");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { document, window } = installTestDom();
window.scrollTo = () => {};
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WorkspaceHost } = await import("./WorkspaceHost");
const { BondingData } = await import("./BondingData");

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
  const view = await mounted((url) => failing ? "error" : { view: answerView(url), section: { state: "empty", provenance } }, { gcTime: 60_000 });
  try {
    assert.match(view.panel().textContent!, /No bonding curves yet/);
    assert.equal(view.panel().querySelector('[aria-label="Refresh bonding curves"]'), null, "no refresh button: choosing a stage reads it again");
    await view.click("Almost graduated");
    assert.match(view.panel().textContent!, /No curve is almost graduated/);
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

test("Bonding opens a setup saved on the retired Graduated stage on New", async () => {
  const ui = await mounted((url) => page(answerView(url), [row("1")]), {}, "graduated");
  try {
    assert.deepEqual(ui.requests.map((url) => url.searchParams.get("view")), ["new"]);
    assert.equal(ui.panel().querySelector('[aria-pressed="true"]')?.textContent, "New");
  } finally {
    await ui.dispose();
  }
});
