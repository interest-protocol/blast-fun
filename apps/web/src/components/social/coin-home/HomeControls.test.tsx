import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CoinsListControls } = await import("./HomeControls.tsx");
const { HOME_DEFAULT_FEED } = await import("./home-state.ts");
type HomeViewState = import("./home-state.ts").HomeViewState;

test("a phone sorts Home from the Filters sheet, starting with the tab's own order", async (t) => {
  t.mock.method(window, "matchMedia", (query: string) => ({ matches: query === "(max-width: 760px)", media: query, addEventListener() {}, removeEventListener() {} }));
  // The sheet mounts in the Blast UI root, as in the app shell.
  const container = document.createElement("div"); container.dataset.blastUi = ""; document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const picked: HomeViewState[] = [];
  const render = async (state: HomeViewState) => act(async () => root.render(<CoinsListControls onChange={(next) => picked.push(next)} state={state} />));
  const options = () => [...document.querySelectorAll<HTMLOptionElement>('select[aria-label="Sort"] option')].map((option) => option.textContent);

  await render(HOME_DEFAULT_FEED);
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  await waitFor(() => document.querySelector('select[aria-label="Sort"]'), "the Filters sheet");
  assert.deepEqual(options(), ["Trending", "Market cap", "Volume", "Most held"]);
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Sort"]')!;
  await act(async () => { select.value = "held"; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
  assert.equal(picked.at(-1)?.sort, "held");

  // A narrowed stage keeps its own order on offer after a column order is picked.
  await render({ ...HOME_DEFAULT_FEED, stage: "almost", sort: "market_cap" });
  assert.deepEqual(options(), ["Progress", "Market cap", "Volume", "Most held"]);
  // Following and the Watchlist keep their own order: no sort to pick.
  await render({ ...HOME_DEFAULT_FEED, source: "following" });
  assert.deepEqual(options(), []);
});

test("a phone's coin list has no column header row", async () => {
  const { readFileSync } = await import("#web/test/css-design-px.ts");
  const css = readFileSync(new URL("./CoinHome.module.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 760px\) \{ \.listHead\.cols \{ display: none; \} \}/);
});
