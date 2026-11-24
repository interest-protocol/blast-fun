import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { readFileSync } from "#web/test/css-design-px.ts";
import { createWorkspaceStore } from "./model";
import { encodeWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { workspaceJournalKey } from "./journal";
import type { CoinPanelProps } from "./panels/CoinPanel";

/**
 * The focus board (BlastMode.dc.html): the holders card under the chart is part of the coin's
 * board, not of Discover, so collapsing or expanding Discover leaves it where it is; Discover's
 * footer (the coins pager) is centred across the column.
 */

const asset = { chain: "sui", network: "mainnet", coin_type: "0x2::coin::A", presale_id: null } as const;
const reads: CoinPanelProps["reads"] = { coin: async () => null, chart: async () => null, holders: async () => null, activity: async () => null };

async function mountedFocus() {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test/", pretendToBeVisual: true });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    CSS: { escape: (value: string) => value }, AbortController: dom.window.AbortController, AbortSignal: dom.window.AbortSignal,
    getComputedStyle: dom.window.getComputedStyle, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  Object.assign(dom.window, { innerWidth: 1440, innerHeight: 1156 });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.getAnimations = () => [];
  dom.window.HTMLElement.prototype.animate = () => { const animation = { cancel() {}, onfinish: null as null | (() => void) }; queueMicrotask(() => animation.onfinish?.()); return animation as unknown as Animation; };

  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset });
  store.setPresentation("focus");
  store.focus("A");
  store.setDataCollapsed(false);
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
  const click = async (label: string) => {
    const button = dom.window.document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    assert.ok(button, `${label} is on the page`);
    await act(async () => button.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  };
  return { dom, click, async dispose() { await act(async () => root.unmount()); dom.window.close(); } };
}

test("collapsing Discover leaves the holders card under the chart, mounted and shown, and expanding keeps it", async () => {
  const page = await mountedFocus();
  try {
    const doc = page.dom.window.document;
    const card = () => doc.querySelector<HTMLElement>('[data-workspace-section="activity"]');
    const shown = (element: HTMLElement) => !element.closest("[hidden],[inert]");
    const holders = card();
    assert.ok(holders, "the holders card is on the board");
    const board = holders.parentElement!;
    assert.ok(board.querySelector('[data-workspace-section="chart"]'), "beside the chart on the same board");
    await page.click("Collapse discovery");
    assert.ok(doc.querySelector('button[aria-label="Expand discovery"]'), "Discover is collapsed");
    assert.equal(card(), holders, "the same card stays mounted");
    assert.equal(holders.parentElement, board, "in the same board");
    assert.ok(shown(holders), "and shown");
    await page.click("Expand discovery");
    assert.equal(card(), holders);
    assert.ok(shown(holders));
  } finally {
    await page.dispose();
  }
});

test("the board's rows do not depend on Discover: the holders row is fixed, and no collapsed rule hides the board", () => {
  const layout = readFileSync(new URL("./WorkspaceLayout.module.css", import.meta.url), "utf8");
  // The board's sizes (340 and 350) unless its splitters moved them (WorkspaceLayout.tsx, owner 2026-10-27).
  assert.match(layout, /\.board \{ position:relative; display:grid; grid-template-columns:minmax\(0,1fr\) var\(--board-ticket, 340px\); grid-template-rows:minmax\(416px,1fr\) var\(--board-holders, 350px\);/);
  assert.match(layout, /\.board > \.section\[data-workspace-section="activity"\] \{ grid-column:1; grid-row:2; \}/);
  assert.doesNotMatch(layout, /data-data-open[^{]*\{/, "the board grid never reads Discover's state");
  const host = readFileSync(new URL("./WorkspaceHost.module.css", import.meta.url), "utf8");
  assert.doesNotMatch(host, /data-data-open="false"\][^{]*(\.workspaceMain|\.panels)[^{]*\{[^}]*display:none/, "collapsing Discover never hides the board");
});

test("Discover's footer, the coins pager, is centred across the column, 10px below the rows, inside the body's one 14px inset", () => {
  const coins = readFileSync(new URL("./CoinsData.module.css", import.meta.url), "utf8");
  assert.match(coins, /:global\(#workspace-data\) \.coinsPager \{ justify-content:center; padding:10px 0 0; \}/);
  const pager = readFileSync(new URL("../../../blast-ui/Pager.module.css", import.meta.url), "utf8");
  assert.match(pager, /\.pager \{ display: flex;[^}]*max-width: 100%;/, "the pager is a flex row that can span its column");
  assert.doesNotMatch(pager, /\.pager \{[^}]*(?<![-\w])width:/, "and has no fixed width that would pull it off centre");
});
