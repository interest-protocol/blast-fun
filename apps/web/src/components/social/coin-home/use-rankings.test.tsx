import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { installTestDom, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import type { HomeCoin } from "@blast/core/modules/social/contracts/home.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useRankings } = await import("./use-rankings");
const { useRankMotion } = await import("./use-rank-motion");
const { HeaderRankingControls, RankingControls, useRankingsSlot } = await import("./RankingControls");
const { createRankingsStore, RankingsSlot } = await import("./rankings-store");
const coin = (id: string, price = "1") => ({ presale_id: id, price_usd: price }) as HomeCoin;

function List({ latest, view, holdIncoming }: { latest?: readonly HomeCoin[]; view: string; holdIncoming: boolean }) {
  const ranking = useRankings(latest, view, { holdIncoming });
  const slotted = useRankingsSlot(ranking);
  const ref = useRankMotion(`${view}:${ranking.motionVersion}`);
  return <>
    {slotted ? null : <RankingControls rankings={ranking} />}
    <ol ref={ref} {...ranking.interactionProps}>{ranking.coins.map(coin => <li key={coin.presale_id} data-list-row={coin.presale_id} ref={row => {
      if (row) Object.defineProperty(row, "offsetTop", { configurable: true, get: () => Array.from(row.parentElement!.children).indexOf(row) * 60 });
    }}><button>{coin.presale_id}:{coin.price_usd}</button></li>)}</ol>
  </>;
}

async function setup(t: TestContext, slotted = false) {
  const store = createRankingsStore();
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(() => root.unmount()); host.remove(); dom.window.history.replaceState({}, ""); dom.window.localStorage.removeItem("blast.liveRankings"); });
  const render = (latest: readonly HomeCoin[] | undefined, view = "discover", holdIncoming = false) => act(() => {
    const list = <List latest={latest} view={view} holdIncoming={holdIncoming} />;
    root.render(slotted ? <section data-section="coins"><button role="tab" aria-selected="true">Discover</button><RankingsSlot.Provider value={store}><HeaderRankingControls store={store} />{list}</RankingsSlot.Provider></section> : list);
  });
  const ids = () => Array.from(host.querySelectorAll("li")).map(row => row.dataset.listRow);
  const click = (selector: string, detail = 1) => act(() => host.querySelector(selector)!.dispatchEvent(testEvent("click", { detail })));
  return { host, render, ids, click };
}

test("live rankings follow new results even with a saved desktop pause", async t => {
  dom.window.localStorage.setItem("blast.liveRankings", "false");
  const { render, host, ids } = await setup(t, true);
  await render([coin("a"), coin("b")]);
  await render([coin("b"), coin("a", "2")]);
  assert.deepEqual(ids(), ["b", "a"]);
  assert.equal(host.querySelector('[role="switch"]'), null);
});

test("phone rankings follow new results even with a saved desktop pause", async t => {
  const phoneQuery = "(max-width: 760px)";
  const original = dom.window.matchMedia;
  const media = new dom.window.EventTarget();
  let matches = false;
  dom.window.matchMedia = query => query === phoneQuery ? {
    ...original(query),
    get matches() { return matches; },
    addEventListener: media.addEventListener.bind(media),
    removeEventListener: media.removeEventListener.bind(media),
  } : original(query);
  t.after(() => { dom.window.matchMedia = original; });
  dom.window.localStorage.setItem("blast.liveRankings", "false");

  const { host, render, ids } = await setup(t);
  await render([coin("a"), coin("b")]);
  await render([coin("b"), coin("a")]);
  assert.deepEqual(ids(), ["b", "a"]);

  await act(() => {
    matches = true;
    media.dispatchEvent(new dom.window.Event("change"));
  });
  assert.deepEqual(ids(), ["b", "a"]);
  const tapped = host.querySelector<HTMLButtonElement>("li button")!;
  const matchesSelector = tapped.matches.bind(tapped);
  Object.defineProperty(tapped, "matches", {
    value: (selector: string) => selector !== ":focus-visible" && matchesSelector(selector),
  });
  await act(() => tapped.focus());
  await render([coin("c"), coin("b")]);
  assert.deepEqual(ids(), ["c", "b"]);
  assert.equal(dom.document.activeElement, tapped);
  await act(() => tapped.blur());
  assert.equal(dom.window.localStorage.getItem("blast.liveRankings"), "false");

  await act(() => {
    matches = false;
    media.dispatchEvent(new dom.window.Event("change"));
  });
  await render([coin("b"), coin("c")]);
  assert.deepEqual(ids(), ["b", "c"]);
});

test("pointer, touch, and keyboard interaction hold positions until release without freezing prices", async t => {
  const { host, render, ids } = await setup(t);
  await render([coin("a"), coin("b")]);
  const list = host.querySelector("ol")!;
  await act(() => list.dispatchEvent(testEvent("pointerover", { pointerType: "mouse" })));
  await render([coin("b"), coin("a", "2")]);
  assert.deepEqual(ids(), ["a", "b"]);
  assert.equal(host.querySelector("li button")!.textContent, "a:2");
  await act(() => list.dispatchEvent(testEvent("pointerout", { pointerType: "mouse", relatedTarget: host })));
  assert.deepEqual(ids(), ["b", "a"]);
  const focused = host.querySelector<HTMLButtonElement>("li button")!;
  await act(() => focused.focus());
  await render([coin("a"), coin("b", "3")]);
  assert.deepEqual(ids(), ["b", "a"]);
  assert.equal(focused.textContent, "b:3");
  assert.equal(dom.document.activeElement, focused);
  await act(() => focused.blur());
  assert.deepEqual(ids(), ["a", "b"]);
  await act(() => list.dispatchEvent(testEvent("pointerdown", { pointerType: "touch" })));
  await render([coin("b"), coin("a")]);
  assert.deepEqual(ids(), ["a", "b"]);
  await act(() => list.dispatchEvent(testEvent("pointercancel", { pointerType: "touch" })));
  assert.deepEqual(ids(), ["b", "a"]);
});

test("Newest holds incoming coins for one press while prices and page membership counts stay current", async t => {
  const { host, render, ids, click } = await setup(t, true);
  const newest = (coins: readonly HomeCoin[]) => render(coins, "newest:1", true);
  const admit = () => host.querySelector<HTMLButtonElement>("button[data-ui-button]");
  await newest([]);
  await newest([coin("a"), coin("b")]);
  assert.deepEqual(ids(), ["a", "b"], "an empty page can show its first coins");
  await newest([coin("b"), coin("a")]);
  assert.equal(admit(), null, "a reshuffle has no incoming identities");
  const focused = host.querySelector<HTMLButtonElement>("li button")!;
  await act(() => focused.focus());
  await newest([coin("c"), coin("b", "2")]);
  assert.deepEqual(ids(), ["b", "a"]);
  assert.equal(focused.textContent, "b:2");
  assert.equal(dom.document.activeElement, focused);
  await act(() => focused.blur());
  assert.deepEqual(ids(), ["b", "a"], "leaving the list does not admit new coins");
  assert.equal(admit()?.textContent, "Show 1 new coin");
  await newest([coin("d"), coin("c")]);
  assert.equal(admit()?.textContent, "Show 2 new coins");
  await newest([coin("e"), coin("a")]);
  assert.equal(admit()?.textContent, "Show 1 new coin", "only the latest confirmed page will be admitted");
  await act(() => admit()!.focus());
  await click("button[data-ui-button]", 0);
  assert.deepEqual(ids(), ["e", "a"]);
  assert.equal(admit(), null);
  assert.equal(dom.document.activeElement, host.querySelector('[role="tab"]'));
  await newest([coin("f"), coin("e")]);
  await render([coin("g")], "newest:filtered", true);
  assert.deepEqual(ids(), ["g"], "another filter adopts its own answer");
  assert.equal(admit(), null);
  await render([coin("p")], "newest:2");
  await render([coin("q")], "newest:2");
  assert.deepEqual(ids(), ["q"], "later pages keep their live ranking behavior");
});
