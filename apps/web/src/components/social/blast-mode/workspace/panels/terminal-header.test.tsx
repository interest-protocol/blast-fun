import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { notifyShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { fixtureCoinType, fixtureWallet } from "../../../../../../test/fixtures/social/trade/trade-fixtures.ts";
import { CoinPosition, CoinPositionMetrics, useCoinPosition } from "./CoinFocusContext";
import { ProjectLinks } from "./ProjectLinks";
import { PanelIdentity } from "./PanelChrome";
import type { CoinPanelProps } from "./CoinPanel";

const asset = { chain: "sui", network: "mainnet", coin_type: fixtureCoinType("KSTL"), presale_id: null } as const;
const coin = { coin_type: asset.coin_type, name: "Kestrel", symbol: "KSTL", decimals: 9, price_usd: "0.0021" };

test("header and expanded holdings share one read and clear private values when actor, visibility or read state changes", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  let calls = 0;
  let result: "ready" | "pending" | "error" | "zero" | "tiny" = "ready";
  const trade = { wallet: async () => { calls++; if (result === "error") throw new Error("Unavailable"); if (result === "pending") return new Promise<never>(() => {}); return fixtureWallet("sponsored", { kstl: result === "zero" ? 0n : result === "tiny" ? 1n : undefined }); } } as NonNullable<CoinPanelProps["actions"]["trade"]>;
  function Subject({ actor = "A", visible = true, authenticated = true }: { actor?: string; visible?: boolean; authenticated?: boolean }) {
    const position = useCoinPosition({ asset, coin, visible, actions: { actor_key: actor, authenticated, trade, signIn: () => {} } });
    return <><dl data-header data-holding={position.hasHolding === null ? "unknown" : String(position.hasHolding)}><CoinPositionMetrics position={position} signIn={() => {}} /></dl><section data-expanded><CoinPosition position={position} signIn={() => {}} /></section></>;
  }
  const render = async (props: Parameters<typeof Subject>[0]) => act(async () => { root.render(<Subject {...props} />); });
  try {
    await render({}); assert.equal(calls, 1); assert.match(document.querySelector('[data-header]')!.textContent!, /600,000 KSTL/); assert.match(document.querySelector('[data-expanded]')!.textContent!, /600,000/);
    await act(async () => { document.querySelector('[data-blast-ui]')!.setAttribute('data-amounts', 'hidden'); notifyShellPrefs(); });
    assert.doesNotMatch(document.body.textContent!, /600,000|1260|1,260/); assert.equal(document.querySelectorAll('[aria-label*="exact asset balance"]').length, 0);
    await act(async () => { document.querySelector('[data-blast-ui]')!.setAttribute('data-amounts', 'shown'); notifyShellPrefs(); });
    result = "pending"; await render({ actor: "B" }); assert.doesNotMatch(document.body.textContent!, /600,000|1,260/); assert.ok(document.querySelector('[data-header] [role="status"]'));
    result = "error"; await render({ actor: "C" }); assert.match(document.body.textContent!, /Unavailable/); assert.doesNotMatch(document.body.textContent!, /600,000/); assert.equal(document.querySelector('[data-header]')!.getAttribute('data-holding'), 'unknown');
    result = "zero"; await render({ actor: "D" }); assert.match(document.querySelector('[data-header]')!.textContent!, /0 KSTL/); assert.equal(document.querySelector('[data-header]')!.getAttribute('data-holding'), 'false');
    result = "tiny"; await render({ actor: "E" }); assert.ok(document.querySelector('[aria-label="Inspect full exact asset balance: 0.000000001"]')); assert.equal(document.querySelector('[data-header]')!.getAttribute('data-holding'), 'true');
    const before = calls; await render({ actor: "F", visible: false }); assert.equal(calls, before); assert.doesNotMatch(document.body.textContent!, /0\.000000001/);
    await render({ actor: "guest", authenticated: false }); assert.equal(calls, before); assert.match(document.body.textContent!, /Sign in/);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});

test("address copy writes the canonical type independently of inspection and acknowledges completion", async () => {
  const dom = new JSDOM('<div id="mount"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let copied: string | null = null;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value: string) => { copied = value; } } } });
  const root = createRoot(document.getElementById('mount')!);
  try {
    await act(async () => root.render(<PanelIdentity stable coinType={asset.coin_type} symbol="KSTL" stage="Trading" />));
    assert.match(document.body.textContent!, /0x7a3f…c91e/);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Copy KSTL coin address"]')!.click());
    assert.equal(copied, asset.coin_type); assert.ok(document.querySelector('[aria-label="Copied"]')); assert.match(document.querySelector('[role="status"]')!.textContent!, /Copied to clipboard/); assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { await act(async () => root.unmount()); if (previous) Object.defineProperty(globalThis, "navigator", previous); dom.window.close(); }
});

test("project icons contain only stored HTTPS website and valid social destinations", () => {
  assert.equal(renderToStaticMarkup(<ProjectLinks metadata={null} />), "");
  assert.equal(renderToStaticMarkup(<ProjectLinks metadata={{ site: "javascript:alert(1)", x_handle: "bad/path", telegram: "bad?query" }} />), "");
  const dom = new JSDOM(renderToStaticMarkup(<ProjectLinks metadata={{ site: "https://example.com", x_handle: "example", telegram: "example" }} />));
  assert.deepEqual([...dom.window.document.querySelectorAll('a')].map(a => a.href), ['https://example.com/', 'https://x.com/example', 'https://t.me/example']);
  assert.ok([...dom.window.document.querySelectorAll('a')].every(a => a.rel.includes('noopener') && a.ariaLabel?.includes('new tab')));
  dom.window.close();
});
