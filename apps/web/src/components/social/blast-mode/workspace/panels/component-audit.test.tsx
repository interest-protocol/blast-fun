import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PresaleFocusDetails } from "./PresaleFocusDetails";
import { presaleDetail } from "../../../../../../test/fixtures/workspace/presale-fixtures";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { CoinPosts } from "./CoinPosts";
import { CoinInformation } from "./CoinInformation";
import type { CoinRecord } from "./coin-reads";
import { terminalUsd } from "./coin-facts";
import { WorkspaceLiveProvider } from "../live-clock";
import { handClock } from "../../../../../../test/fixtures/workspace/live-clock";
import { auditPosts, auditPresaleId } from "../../../../../../test/fixtures/workspace/audit-fixtures";
import { fixtureCoinType } from "../../../../../../test/fixtures/social/trade/trade-fixtures";

const asset = { chain: "sui", network: "mainnet", coin_type: fixtureCoinType("KSTL"), presale_id: auditPresaleId } as const;

test("coin information compacts long participant counts while retaining exact counts and known zeros, and omits unknown metadata", () => {
  const activity = {
    scope: "pool" as const, window: "24h" as const, from_ms: 1790251260000, to_ms: 1790337660000,
    buyers: 1234567, sellers: 1234567890, participants: 1235802457, events: 1235802457,
    backers: 0, claimers: 0, bought: [], sold: [], committed: [], latest_ms: null, preview: [],
  };
  const coin: CoinRecord = { coin_type: asset.coin_type, symbol: "KSTL", name: "Kestrel", decimals: 9, price_usd: null, activity };
  const render = (value: CoinRecord | null, compact: boolean) => new JSDOM(renderToStaticMarkup(<CoinInformation asset={asset} coin={value} compact={compact} />));
  for (const compact of [true, false]) {
    const dom = render(coin, compact);
    try {
      const buyers = dom.window.document.querySelector<HTMLButtonElement>('[aria-label^="Inspect full buyers:"]')!;
      const sellers = dom.window.document.querySelector<HTMLButtonElement>('[aria-label^="Inspect full sellers:"]')!;
      assert.equal(buyers.textContent, "1.2M");
      assert.equal(sellers.textContent, "1.2B");
      assert.equal(buyers.getAttribute("aria-label"), "Inspect full buyers: 1,234,567");
      assert.equal(sellers.getAttribute("aria-label"), "Inspect full sellers: 1,234,567,890");
      assert.equal(dom.window.document.querySelector("h2")?.textContent, compact ? "Activity" : undefined);
      assert.equal(dom.window.document.querySelector('[aria-label$="Copy full coin address"]') !== null, !compact);
    } finally { dom.window.close(); }
  }
  const zero = render({ ...coin, activity: { ...activity, buyers: 0, sellers: 0, participants: 0, events: 0 } }, true);
  const unknown = render({ ...coin, decimals: null, activity: null }, false);
  try {
    assert.deepEqual([...zero.window.document.querySelectorAll("dd")].map((cell) => cell.textContent), ["0", "0"]);
    assert.equal(zero.window.document.querySelector("button"), null);
    assert.doesNotMatch(unknown.window.document.body.textContent!, /Decimals|Buyers|Sellers|Unavailable|All venues/);
    assert.equal(unknown.window.document.querySelector("[data-inspect-value]"), null);
    assert.match(unknown.window.document.querySelector("[data-coin-type-tag] code")?.textContent ?? "", /^0x[\da-f]{4}…[\da-f]{4}$/);
  } finally { zero.window.close(); unknown.window.close(); }
});

test("posts retain a valid page when a polled page shrinks, expose meaningful labels and support confirmed empty/error recovery", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  const time = handClock();
  let count = 7, fail = false;
  const reads = { posts: async () => { if (fail) throw new Error("Unavailable"); return auditPosts(auditPresaleId, count); } };
  const rows = () => document.querySelectorAll('ol[aria-label="Coin posts"] > li');
  const click = async (text: string) => act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === text)!.click());
  try {
    await act(async () => root.render(<WorkspaceLiveProvider clock={time.clock}><CoinPosts asset={asset} reads={reads} visible /></WorkspaceLiveProvider>));
    assert.equal(rows().length, 3);
    assert.match(rows()[0]!.querySelector("button")!.getAttribute("aria-label")!, /Read post by Alexandria.*thoughtful discussion/);
    await click("More posts"); await click("More posts"); assert.equal(rows().length, 1);
    count = 2; await act(async () => time.advance(15_000)); assert.equal(rows().length, 2, "a shrinking snapshot never leaves a falsely empty page");
    assert.ok(![...document.querySelectorAll("button")].some(button => button.textContent === "Previous posts"));
    count = 0; await act(async () => time.advance(15_000)); assert.match(document.body.textContent!, /No posts yet/);
    fail = true; await act(async () => time.advance(15_000)); assert.match(document.body.textContent!, /Posts could not load/); assert.doesNotMatch(document.body.textContent!, /No posts yet/);
    fail = false; count = 2; await click("Retry posts"); assert.equal(rows().length, 2);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});

test("compact terminal dollars retain sign and meaningful tiny values, and keep huge values readable", () => {
  assert.equal(terminalUsd("123456789012345.678901"), "$123.46T");
  assert.equal(terminalUsd("-9007199254.74099301"), "−$9.01B");
  assert.equal(terminalUsd("+0"), "$0");
  assert.equal(terminalUsd("0.000000000000000123"), "$0.0₁₅123");
  assert.equal(terminalUsd("bad"), "—");
});


test("presale details distinguish missing vesting facts, explicitly absent schedules and configured timing", () => {
  const detail = presaleDetail();
  const render = (terms: typeof detail.terms) => renderToStaticMarkup(<PresaleFocusDetails detail={{ ...detail, terms }} pending={false} visible />);
  assert.match(render(null), /<dt>Vesting<\/dt><dd>Unavailable<\/dd>/);
  assert.match(render({ ...detail.terms!, buyer_vesting: undefined }), /<dt>Vesting<\/dt><dd>Unavailable<\/dd>/);
  assert.match(render({ ...detail.terms!, buyer_vesting: null }), /<dt>Vesting<\/dt><dd>None<\/dd>/);
  assert.match(render({ ...detail.terms!, buyer_vesting: { cliff_ms: "31536000000", duration_ms: "94608000000" } }), /365 day cliff · 1095 days from first claim/);
});
