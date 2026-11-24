import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { installTestDom } from "../../../../../test/fixtures/social/test-dom.ts";
installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

import { readFileSync } from "node:fs";
import { createWorkspaceStore } from "./model";
import { encodeWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { workspaceJournalKey } from "./journal";
import type { CoinPanelProps } from "./panels/CoinPanel";

/**
 * Blast mode audit, pass C (2026-10-28): the board composes by available width. 1440 and wider is
 * the approved board; 1100–1439 shows Discover on its rail for someone who hasn't chosen; below
 * 1100 Discover is a sheet and the header stays one row down to 768px; there a board
 * under 960px is one task view at a time (Chart, Trade, Activity) with the selection on screen.
 * The right column fills the desktop board to its bottom.
 */

const css = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const asset = { chain: "sui", network: "mainnet", coin_type: "0x2::coin::A", presale_id: null } as const;
const reads: CoinPanelProps["reads"] = { coin: async () => null, chart: async () => null, holders: async () => null, activity: async () => null };

async function mounted({ width = 1440, height = 900, boardWidth, storage, collapsed = false }: Readonly<{ width?: number; height?: number; boardWidth?: number; storage?: Record<string, string>; collapsed?: boolean }> = {}) {
  const sheet = width < 1100;
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test/", pretendToBeVisual: true });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    CSS: { escape: (value: string) => value }, AbortController: dom.window.AbortController, AbortSignal: dom.window.AbortSignal,
    getComputedStyle: dom.window.getComputedStyle, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  Object.assign(dom.window, { innerWidth: width, innerHeight: height });
  dom.window.matchMedia = (query: string) => ({ matches: query === "(max-width:1099px)" && sheet, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.getAnimations = () => [];
  dom.window.HTMLElement.prototype.animate = () => { const animation = { cancel() {}, onfinish: null as null | (() => void) }; queueMicrotask(() => animation.onfinish?.()); return animation as unknown as Animation; };
  // jsdom lays nothing out: the board's measured width is what this test says it is.
  if (boardWidth !== undefined) Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return boardWidth; } });
  for (const [key, value] of Object.entries(storage ?? {})) dom.window.localStorage.setItem(key, value);

  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset });
  store.setPresentation("focus");
  store.focus("A");
  store.setDataCollapsed(collapsed);
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  dom.window.localStorage.setItem(workspaceJournalKey({ actor: { kind: "guest" }, chain: "sui", network: "mainnet" }), encoded.bytes);

  const { WorkspaceHost } = await import("./WorkspaceHost");
  const { CoinPanel } = await import("./panels/CoinPanel");
  const root = createRoot(dom.window.document.getElementById("mount")!);
  await act(async () => root.render(
    <WorkspaceHost
      resolveOwner={async () => ({ kind: "guest" })}
      ownerKey="guest"
      entryGeneration={1}
      onExit={() => {}}
      storage={dom.window.localStorage}
      slots={{
        data: { Coins: () => <p>Coins</p> },
        panel: ({ panel }) => <CoinPanel focus panel_id={panel.panel_id} asset={panel} coin_setup={panel.coin} onSetupChange={() => {}} effective_visibility reads={reads} actions={{ trade: null, authenticated: false, actor_key: "guest", signIn() {} }} />,
      }}
    />,
  ));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const doc = dom.window.document;
  const click = async (element: HTMLElement | null, name: string) => {
    assert.ok(element, `${name} is on the page`);
    await act(async () => element.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  };
  const discoverOpen = () => doc.querySelector("[data-data-open]")?.getAttribute("data-data-open") === "true";
  return { dom, doc, click, discoverOpen, async dispose() { await act(async () => root.unmount()); dom.window.close(); } };
}

test("the right column fills the desktop board to its bottom: its last card grows, level with the holders card or the chart", () => {
  const layout = css("./WorkspaceLayout.module.css");
  assert.match(layout, /\.board > \.section\[data-workspace-section="trade"\] \{ grid-column:2; grid-row:1 \/ -1; \}/, "the column spans every row of the board");
  assert.match(layout, /\[data-terminal-grid="desktop"\] > \.board > \.section\[data-workspace-section="trade"\] \.content > section > :last-child \{ flex:1 0 auto; \}/, "Flow grows to the board's bottom");
  assert.match(css("./panels/FlowCard.module.css"), /\.flow \{ display:flex; flex-direction:column;/, "Flow's content stays at the top of the taller card");
});

test("Discover's width default: collapsed from 1100 to 1439px, the board's open column from 1440", async () => {
  const { discoverDefaultCollapsed } = await import("./discover-default");
  assert.deepEqual([1099, 1100, 1280, 1439, 1440, 1920].map(discoverDefaultCollapsed), [false, true, true, true, false, false]);
});

test("at 1280 Discover shows on its rail for someone who hasn't chosen, without changing the saved workspace; expanding it is a choice the next visit keeps", async () => {
  const journal = workspaceJournalKey({ actor: { kind: "guest" }, chain: "sui", network: "mainnet" });
  const first = await mounted({ width: 1280 });
  try {
    assert.equal(first.discoverOpen(), false, "collapsed to its rail");
    assert.equal(JSON.parse(first.dom.window.localStorage.getItem(journal)!).data.collapsed, false, "the saved workspace keeps Discover open");
    assert.equal(first.dom.window.localStorage.getItem("blast.discover.chosen"), null);
    await first.click(first.doc.querySelector<HTMLButtonElement>('button[aria-label="Expand discovery"]'), "Expand discovery");
    assert.equal(first.discoverOpen(), true);
    assert.equal(first.dom.window.localStorage.getItem("blast.discover.chosen"), "1");
  } finally { await first.dispose(); }
  const again = await mounted({ width: 1280, storage: { "blast.discover.chosen": "1" } });
  try {
    assert.equal(again.discoverOpen(), true, "the person's open Discover is kept at 1280");
  } finally { await again.dispose(); }
});

test("at 1440 the board keeps Discover open, and a saved collapse stays collapsed", async () => {
  const page = await mounted({ width: 1440 });
  try {
    assert.equal(page.discoverOpen(), true);
  } finally { await page.dispose(); }
  const saved = await mounted({ width: 1440, collapsed: true });
  try {
    assert.equal(saved.discoverOpen(), false, "a saved collapse is never reopened");
  } finally { await saved.dispose(); }
});

test("below 960 the board is one task view at a time; the section bar's selection is the view on screen", async () => {
  const page = await mounted({ width: 390, height: 844, boardWidth: 390 });
  try {
    const grid = () => page.doc.querySelector<HTMLElement>("[data-terminal-grid]")!;
    const nav = () => page.doc.querySelector<HTMLElement>('nav[aria-label="Selected market navigation"]');
    const current = () => [...nav()!.querySelectorAll("button[aria-current='true']")].map((button) => button.textContent);
    assert.equal(grid().getAttribute("data-terminal-grid"), "stacked");
    assert.equal(grid().getAttribute("data-compact-view"), "chart", "the chart first");
    assert.deepEqual(current(), ["Chart"]);
    const button = (label: string) => [...nav()!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label) ?? null;
    await page.click(button("Trade"), "Trade");
    assert.equal(grid().getAttribute("data-compact-view"), "trade");
    assert.deepEqual(current(), ["Trade"], "only the view on screen is selected");
    const trade = page.doc.querySelector<HTMLElement>('[data-workspace-section="trade"]')!;
    assert.ok(trade.contains(page.doc.activeElement), "focus follows the committed section");
    button("Trade")!.focus();
    await page.click(button("Trade"), "Trade again");
    assert.ok(trade.contains(page.doc.activeElement), "selecting the same section restores focus too");
    await page.click(button("Activity"), "Activity");
    assert.equal(grid().getAttribute("data-compact-view"), "activity");
    assert.deepEqual(current(), ["Activity"]);
    const layout = css("./WorkspaceLayout.module.css");
    assert.match(layout, /\[data-terminal-grid="stacked"\]\[data-compact-view="chart"\] > \.board > \.section:not\(\[data-workspace-section="chart"\]\)/, "the other sections are not shown");
    assert.doesNotMatch(layout, /\.tradeNav/, "Trade carries no permanent accent");
  } finally { await page.dispose(); }
});

test("opening Discover on a 1280 laptop keeps the side-by-side board; the same board width is one task view where Discover is a sheet", async () => {
  // 1280 − Discover's 300px column − gutters leaves the board 944px.
  const laptop = await mounted({ width: 1280, boardWidth: 944, storage: { "blast.discover.chosen": "1" } });
  try {
    assert.equal(laptop.discoverOpen(), true);
    assert.equal(laptop.doc.querySelector("[data-terminal-grid]")?.getAttribute("data-terminal-grid"), "desktop");
    assert.equal(laptop.doc.querySelector('nav[aria-label="Selected market navigation"]'), null, "no section bar over Discover's column");
  } finally { await laptop.dispose(); }
  const tablet = await mounted({ width: 968, height: 800, boardWidth: 944 });
  try {
    assert.equal(tablet.doc.querySelector("[data-terminal-grid]")?.getAttribute("data-terminal-grid"), "stacked");
    assert.equal(tablet.doc.querySelector("[data-terminal-grid]")?.getAttribute("data-compact-view"), "chart");
  } finally { await tablet.dispose(); }
});

test("below 1100 Discover is a sheet", async () => {
  const page = await mounted({ width: 1099 });
  try {
    await page.click(page.doc.querySelector<HTMLButtonElement>('button[aria-label="Search coins and presales"]'), "Search coins and presales");
    assert.equal(page.doc.querySelector('[role="dialog"] h2')?.textContent, "Discover");
  } finally { await page.dispose(); }
});

test("a narrow chart card folds the style and Volume into one Chart menu instead of scrolling the toolbar", () => {
  const visual = css("./panels/CoinChartVisual.module.css");
  assert.match(visual, /@container focus-chart \(max-width:44rem\) \{\n \.chartOptionsInline \{ display:none; \}\n \.chartOptionsMenu \{ display:inline-flex; flex:none; \}/);
  assert.match(css("./panels/CoinChart.tsx"), /label="Chart options"/);
});

test("one Done: the chart's Overlays and the strip settings close with the same secondary button in a footer that stays in reach while a short screen scrolls the popover", () => {
  for (const [source, sheet] of [["./panels/ChartTrades.tsx", "./panels/ChartTrades.module.css"], ["./WorkspaceSignals.tsx", "./WorkspaceSignals.module.css"]] as const) {
    assert.match(css(source).replace(/\s+/g, " "), /<div className=\{styles\.footer\}> ?<Popover\.Close render=\{<Button (variant="secondary" size="sm"|size="sm" variant="secondary") \/>\}> ?Done ?<\/Popover\.Close> ?<\/div>/, `${source}: Done`);
    const rules = css(sheet).replace(/\s+/g, " ");
    assert.match(rules, /\.popup \{[^}]*max-height: ?min\(40\.625rem, ?75dvh(, ?max\(12rem, ?var\(--available-height, ?75dvh\)\))?\);[^}]*overflow: ?auto;/, `${sheet}: the body scrolls`);
    assert.match(rules, /\.footer \{ ?position: ?sticky;/, `${sheet}: the footer stays in reach`);
  }
});
