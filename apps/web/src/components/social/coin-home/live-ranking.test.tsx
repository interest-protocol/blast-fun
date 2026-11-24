import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, recordAnimations } from "../../../../test/fixtures/social/test-dom.ts";
import type { HomeCoin } from "@blast/core/modules/social/contracts/home.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useLiveCoins } = await import("./use-live-coins");
const { useRankMotion } = await import("./use-rank-motion");
const coin = (id: string, price = "1") => ({ presale_id: id, price_usd: price }) as HomeCoin;

function List({ latest, view }: { latest?: readonly HomeCoin[]; view: string }) {
  const coins = useLiveCoins(latest, view);
  const ref = useRankMotion(view);
  return <ol ref={ref}>{coins.map(coin => <li key={coin.presale_id} data-list-row={coin.presale_id} ref={row => {
    if (row) Object.defineProperty(row, "offsetTop", { configurable: true, get: () => Array.from(row.parentElement!.children).indexOf(row) * 60 });
  }}><button>{coin.presale_id}:{coin.price_usd}</button></li>)}</ol>;
}

test("live ranking preserves focus and history while adopting incoming changes, with reduced motion and view changes immediate", async t => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(() => root.unmount()); host.remove(); dom.window.history.replaceState({}, ""); dom.window.reducedMotion = false; });
  const animations = recordAnimations();
  const render = (latest: readonly HomeCoin[] | undefined, view = "discover") => act(() => root.render(<List latest={latest} view={view} />));
  const ids = () => Array.from(host.querySelectorAll("li")).map(row => row.dataset.listRow);
  const first = [coin("a"), coin("b")];
  await render(first);
  assert.equal(animations.all.length, 0);
  const focus = host.querySelector("button")!;
  focus.focus();
  await render([coin("b"), coin("a", "2")]);
  assert.deepEqual(ids(), ["b", "a"]);
  assert.equal(dom.document.activeElement, focus);
  assert.equal(focus.textContent, "a:2");
  assert.equal(animations.all.length, 2);
  assert.ok(animations.all.every(animation => animation.timing.duration === 180));
  await render([coin("c"), coin("b")]);
  assert.deepEqual(ids(), ["c", "b"]);
  assert.ok(animations.all.slice(0, 2).every(animation => animation.playState === "idle"));
  assert.deepEqual(animations.all[2]!.keyframes, [{ opacity: 0 }, { opacity: 1 }]);
  const count = animations.all.length;
  dom.window.reducedMotion = true;
  await render([coin("b"), coin("c")]);
  assert.deepEqual(ids(), ["b", "c"]);
  assert.equal(animations.all.length, count);
  dom.window.reducedMotion = false;
  await render([coin("c"), coin("b")], "page-two");
  assert.equal(animations.all.length, count);
  await render([]);
  assert.deepEqual(ids(), []);
  await render(undefined, "watchlist");
  assert.deepEqual(ids(), []);
  dom.window.history.replaceState({ blastListContent: { discover: first } }, "");
  const newer = [coin("b"), coin("c")];
  await render(newer);
  const beforeBack = animations.all.length;
  await act(() => dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate")));
  assert.equal(animations.all.length, beforeBack, "history restoration never animates");
  assert.deepEqual(ids(), ["a", "b"]);
  await render(newer);
  assert.deepEqual(ids(), ["a", "b"]);
  await render([coin("c"), coin("a")]);
  assert.deepEqual(ids(), ["c", "a"]);
});
