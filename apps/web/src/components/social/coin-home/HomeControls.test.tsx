import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CoinTabs, CoinsListControls, NewLaunchEmpty } = await import("./HomeControls.tsx");
const { HOME_DEFAULT_FEED, HOME_TABS } = await import("./home-state.ts");
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

  // Home opens on Closest to graduating, ordered by progress.
  await render(HOME_DEFAULT_FEED);
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  await waitFor(() => document.querySelector('select[aria-label="Sort"]'), "the Filters sheet");
  assert.deepEqual(options(), ["Progress", "Market cap", "Volume", "Most held"]);
  // Trending offers its own order first.
  await render({ ...HOME_DEFAULT_FEED, ...HOME_TABS.trending });
  await waitFor(() => document.querySelector('select[aria-label="Sort"]'), "the Filters sheet");
  assert.deepEqual(options(), ["Trending", "Market cap", "Volume", "Most held"]);
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Sort"]')!;
  await act(async () => { select.value = "held"; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
  assert.equal(picked.at(-1)?.sort, "held");

  // A narrowed stage keeps its own order on offer after a column order is picked.
  await render({ ...HOME_DEFAULT_FEED, stage: "almost", sort: "market_cap" });
  assert.deepEqual(options(), ["Progress", "Market cap", "Volume", "Most held"]);
  // A shared link with another order keeps that order shown and chosen.
  await render({ ...HOME_DEFAULT_FEED, stage: "almost", sort: "newest" });
  assert.deepEqual(options(), ["Progress", "Market cap", "Volume", "Most held", "Newest"]);
  assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="Sort"]')!.value, "newest");
  // Following and the Watchlist keep their own order: no sort to pick.
  await render({ ...HOME_DEFAULT_FEED, source: "following" });
  assert.deepEqual(options(), []);
});

test("a phone's coin list has no column header row", async () => {
  const { readFileSync } = await import("#web/test/css-design-px.ts");
  const css = readFileSync(new URL("./CoinHome.module.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 760px\) \{ \.listHead\.cols \{ display: none; \} \}/);
});

test("a Home tab the trader focuses or touches asks for its list; the current tab does not", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const asked: string[] = [];
  await act(async () => root.render(<CoinTabs onChange={() => {}} onIntent={(tab) => asked.push(tab)} panelId="coins" state={HOME_DEFAULT_FEED} />));
  const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const current = tabs.find((tab) => tab.getAttribute("aria-selected") === "true")!;
  const other = tabs.find((tab) => tab !== current)!;
  await act(async () => { current.focus(); current.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true })); });
  assert.deepEqual(asked, []);
  await act(async () => other.focus());
  await act(async () => { other.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true })); });
  assert.deepEqual(asked, [other.id.replace("coins-", ""), other.id.replace("coins-", "")]);
});

test("New shows its one age control, not the Launched filter; its empty state launches or looks back the week", async (t) => {
  t.mock.method(window, "matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  const container = document.createElement("div"); container.dataset.blastUi = ""; document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const picked: HomeViewState[] = [];
  const fresh: HomeViewState = { ...HOME_DEFAULT_FEED, stage: "new", sort: "newest", age: "24h" };
  await act(async () => root.render(<CoinsListControls onChange={(next) => picked.push(next)} state={fresh} />));
  const ages = [...container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Launched"] [role="radio"], [aria-label="Launched"] button')];
  assert.deepEqual(ages.map((button) => button.textContent), ["1h", "24h", "7d"]);
  await act(async () => ages[0]!.click());
  assert.equal(picked.at(-1)?.age, "1h");
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="Filters"], button[aria-haspopup]')!.click());
  await waitFor(() => document.querySelector('select[aria-label="Participants"]'), "the Filters menu");
  assert.equal(document.querySelector('select[aria-label="Launched"]'), null);

  const ageAsked: string[] = [];
  await act(async () => root.render(<NewLaunchEmpty age="24h" onAge={(age) => ageAsked.push(age)} />));
  const actions = [...container.querySelectorAll<HTMLElement>("a, button")];
  assert.deepEqual(actions.map((action) => action.textContent), ["Launch", "7d"]);
  assert.equal(container.textContent?.includes("No coins"), false);
  await act(async () => (actions[1] as HTMLButtonElement).click());
  assert.deepEqual(ageAsked, ["7d"]);
  await act(async () => root.render(<NewLaunchEmpty age="7d" onAge={() => {}} />));
  assert.deepEqual([...container.querySelectorAll("a, button")].map((action) => action.textContent), ["Launch"]);
});
