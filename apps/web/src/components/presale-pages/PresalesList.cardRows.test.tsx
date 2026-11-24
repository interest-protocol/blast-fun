import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { installTestDom, waitFor } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient } = await import("@tanstack/react-query");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { PresalesList } = await import("./PresalesList");
const { fixtureList, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
const { cardStep, fullRows, trackCount } = await import("./card-grid.ts");

const idOf = (index: number) => `0x${(index + 1).toString(16).padStart(64, "0")}`;

type Options = Readonly<{
  /** Live presales, in the order the server lists them. */
  total: number;
  /** Rows per server page. */
  pageSize?: number;
  /** Indexes of listed sales that do not belong under Live, so the grid drops them (the 20 → 16 case). */
  hidden?: readonly number[];
  /** Make the hidden sales open past their end instead (the server still lists them): the page refreshes on a timer. */
  expired?: boolean;
  columns: number;
  layout?: "cards" | "list";
}>;

/** The presales list with a fake paged server and a grid whose measured column count the test controls. */
async function mount(t: TestContext, { total, pageSize = 20, hidden = [], expired = false, columns, layout }: Options) {
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  window.history.replaceState(null, "", layout === "list" ? "/presale?layout=list" : "/presale");
  const seed = fixtureList("live", "ending");
  const base = seed.presales[0]!;
  const sales = Array.from({ length: total }, (_, index) => ({
    ...base,
    presale_id: idOf(index),
    name: `Sale ${index}`,
    ...(hidden.includes(index)
      ? expired
        ? { phase: "open" as const, start_ms: FIXTURE_NOW - 7_200_000, end_ms: FIXTURE_NOW - 1_000 }
        : { phase: "pending" as const, start_ms: FIXTURE_NOW + 3_600_000, end_ms: FIXTURE_NOW + 7_200_000 }
      : { start_ms: FIXTURE_NOW - 60_000, end_ms: FIXTURE_NOW + 3_600_000 }),
  }));
  const page = (from: number) => ({ ...seed, presales: sales.slice(from, from + pageSize), next_cursor: from + pageSize < total ? `from-${from + pageSize}` : null });
  const reads: (string | null)[] = [];
  let inFlight = 0;
  let gate: Promise<void> | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const cursor = new URL(String(input), "http://127.0.0.1").searchParams.get("cursor");
    reads.push(cursor);
    inFlight++;
    await (gate ?? Promise.resolve());
    inFlight--;
    return Response.json(page(cursor ? Number(cursor.slice(5)) : 0));
  };

  let tracks = columns;
  const observed = new Set<() => void>();
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: () => void) {}
    observe() { observed.add(this.callback); }
    unobserve() { observed.delete(this.callback); }
    disconnect() { observed.delete(this.callback); }
  } as unknown as typeof ResizeObserver;
  const originalStyle = globalThis.getComputedStyle;
  t.mock.method(globalThis, "getComputedStyle", (element: Element, pseudo?: string | null) =>
    element.classList.contains("presale-grid")
      ? { gridTemplateColumns: Array.from({ length: tracks }, () => "300px").join(" ") }
      : originalStyle(element, pseudo));

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
    globalThis.ResizeObserver = originalObserver;
  });
  const render = () => act(async () => root.render(
    <QueryProvider client={client}>
      <PresalesList initial={page(0)} layout={layout} nowMs={FIXTURE_NOW} sort="pinned" status="live" view="list" />
    </QueryProvider>,
  ));
  await render();
  const showMoreButton = () => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.startsWith("Show more"));
  /** Reads finished and no "Show more" still loading. */
  const settle = () => waitFor(() => inFlight === 0 && !showMoreButton()?.disabled, "the grid to finish reading pages");
  await settle();
  const cards = () => [...container.querySelectorAll(".presale-grid > *")];
  return {
    reads,
    settle,
    /** Hold every read until the returned function is called. */
    hold() {
      let release = () => {};
      gate = new Promise<void>((resolve) => { release = resolve; });
      return () => { gate = null; release(); };
    },
    /** Leave the page and come Back: the list is saved to history first, then mounted again. */
    async back({ settle: wait = true } = {}) {
      await act(async () => { window.dispatchEvent(new window.Event("blast:capture-lists")); });
      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
      if (wait) await settle();
    },
    hrefs: () => cards().map((card) => card.querySelector("a")?.getAttribute("href")),
    count: () => cards().length,
    listIds: () => [...container.querySelectorAll("[data-list-row]")].map(row => row.getAttribute("data-list-row")),
    /** Everything in the grid is a real card: no placeholder, no empty slot. */
    onlyCards: () => cards().every((card) => card.matches("article.presale-tile")),
    showMore: () => showMoreButton() ?? null,
    async press() {
      const button = showMoreButton();
      assert.ok(button, "Show more is offered");
      await act(async () => button.click());
      await settle();
    },
    async resize(next: number) {
      tracks = next;
      await act(async () => observed.forEach((callback) => callback()));
      await settle();
    },
    /** The first `count` visible cards' links, in server order, skipping the hidden sales. */
    expectedIds: (count: number) => Array.from({ length: total }, (_, index) => index).filter((index) => !hidden.includes(index)).slice(0, count).map((index) => `/presale/${idOf(index)}`),
  };
}

test("grid sizes follow whole rows", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(cardStep), [18, 18, 18, 20, 20, 18]);
  assert.equal(fullRows(18, 4), 20);
  assert.equal(fullRows(36, 3), 36);
  assert.equal(trackCount("300px 300px 300px"), 3);
  assert.equal(trackCount("none"), 0);
  assert.equal(trackCount(""), 0);
});

// Every result is on the first page; three columns.
for (const [total, shown, more] of [[16, 16, false], [17, 17, false], [18, 18, false], [19, 18, true], [25, 18, true], [40, 18, true]] as const) {
  test(`three columns, ${total} results: ${shown} cards${more ? " and Show more" : ", no Show more"}`, async (t) => {
    const view = await mount(t, { total, columns: 3 });
    assert.equal(view.count(), shown);
    assert.deepEqual(view.hrefs(), view.expectedIds(shown));
    assert.equal(view.onlyCards(), true);
    assert.equal(!!view.showMore(), more);
    assert.deepEqual(view.reads.filter((cursor) => cursor !== null), [], "a page that is full needs no extra read");
  });
}

test("the reported case: 20 listed, 4 of them not Live, 16 show; the next page fills the sixth row", async (t) => {
  const view = await mount(t, { total: 60, hidden: [3, 7, 11, 15], columns: 3 });
  assert.equal(view.count(), 18, "three full rows of six");
  assert.equal(view.onlyCards(), true);
  const ids = view.hrefs();
  assert.equal(new Set(ids).size, ids.length, "no duplicates");
  assert.ok(!ids.includes(`/presale/${idOf(3)}`), "sales outside Live stay out");
  assert.deepEqual(ids, view.expectedIds(18), "order kept");
  assert.ok(view.showMore(), "more cards remain");
  assert.deepEqual(view.reads.filter((cursor) => cursor !== null), ["from-20"], "one extra read, no more");
});

test("the timed refresh of listed-but-ended sales keeps the cards and reads no later page again", async (t) => {
  const timers = new Map<number, () => void>();
  let nextTimer = 1000;
  const realSet = window.setInterval.bind(window);
  const realClear = window.clearInterval.bind(window);
  // The page's own 30 s refresh timer only; the rest keep running for real.
  t.mock.method(window, "setInterval", (callback: () => void, delay?: number) => {
    if (typeof delay === "number" && delay >= 20_000) { timers.set(++nextTimer, callback); return nextTimer; }
    return realSet(callback, delay);
  });
  t.mock.method(window, "clearInterval", (id?: number) => { if (id !== undefined && timers.delete(id)) return; realClear(id); });
  const view = await mount(t, { total: 60, hidden: [3, 7, 11, 15], expired: true, columns: 3 });
  assert.equal(view.count(), 18);
  await view.press();
  assert.equal(view.count(), 36);
  const reads = view.reads.length;
  const seen: number[] = [];
  for (let tick = 0; tick < 3; tick++) {
    await act(async () => { for (const callback of timers.values()) callback(); });
    await view.settle();
    seen.push(view.count());
    assert.ok(timers.size > 0, "the refresh timer is running");
  }
  assert.deepEqual(seen, [36, 36, 36], "no shrink to page one and back");
  const later = view.reads.slice(reads).filter((cursor) => cursor !== null);
  assert.deepEqual(later, [], "the pages already read are not read again");
  assert.deepEqual(view.hrefs(), view.expectedIds(36));
});

test("Back to the list shows the cards that were revealed, in order", async (t) => {
  const view = await mount(t, { total: 60, columns: 3 });
  await view.press();
  await view.press();
  assert.equal(view.count(), 54);
  await view.back();
  assert.equal(view.count(), 54, "the same cards, not 18 again and not every loaded row");
  assert.deepEqual(view.hrefs(), view.expectedIds(54));
  await view.press();
  assert.equal(view.count(), 60);
});

test("Back reads the revealed count from an older list entry", async (t) => {
  const view = await mount(t, { total: 50, columns: 3, pageSize: 50 });
  window.dispatchEvent(new window.Event("blast:capture-lists"));
  const id = "presales:public";
  const saved = window.history.state.blastLists[id];
  window.history.replaceState({ blastLists: { [id]: { ...saved, value: { ...saved.value, revealed: 36 } } } }, "");
  await act(async () => { window.dispatchEvent(new window.Event("popstate")); });
  assert.equal(view.count(), 36);
});

test("Back in the reported case reads nothing twice and shows no duplicate", async (t) => {
  const view = await mount(t, { total: 60, hidden: [3, 7, 11, 15], columns: 3 });
  assert.equal(view.count(), 18);
  const before = view.reads.length;
  const release = view.hold();
  await view.back({ settle: false });
  release();
  await view.settle();
  const ids = view.hrefs();
  assert.equal(ids.length, 18);
  assert.equal(new Set(ids).size, ids.length, "no duplicates");
  assert.deepEqual(ids, view.expectedIds(18));
  assert.equal(view.reads.slice(before).filter((cursor) => cursor !== null).length <= 1, true, "at most the one page read the first render starts");
  while (view.showMore()) await view.press();
  const more = view.hrefs();
  assert.equal(new Set(more).size, more.length, "the page read at first render did not land on the restored rows twice");
  assert.deepEqual(more, view.expectedIds(56), "all 56 Live sales, once each, in order");
});

test("the timed refresh keeps every card once all the pages are read", async (t) => {
  const timers = new Map<number, () => void>();
  let nextTimer = 1000;
  const realSet = window.setInterval.bind(window);
  const realClear = window.clearInterval.bind(window);
  t.mock.method(window, "setInterval", (callback: () => void, delay?: number) => {
    if (typeof delay === "number" && delay >= 20_000) { timers.set(++nextTimer, callback); return nextTimer; }
    return realSet(callback, delay);
  });
  t.mock.method(window, "clearInterval", (id?: number) => { if (id !== undefined && timers.delete(id)) return; realClear(id); });
  const view = await mount(t, { total: 60, hidden: [3, 7, 11, 15], expired: true, columns: 3 });
  for (let step = 0; step < 3; step++) await view.press();
  assert.equal(view.count(), 56, "all 56 Live sales");
  assert.equal(view.showMore(), null);
  const reads = view.reads.length;
  await act(async () => { for (const callback of timers.values()) callback(); });
  await view.settle();
  assert.equal(view.count(), 56);
  assert.deepEqual(view.reads.slice(reads).filter((cursor) => cursor !== null), [], "no later page read again");
});

test("Show more reveals whole rows and keeps the order", async (t) => {
  const view = await mount(t, { total: 60, columns: 3 });
  assert.equal(view.count(), 18);
  await view.press();
  assert.equal(view.count(), 36);
  assert.deepEqual(view.hrefs(), view.expectedIds(36));
  await view.press();
  assert.equal(view.count(), 54);
  assert.equal(view.onlyCards(), true);
  await view.press();
  assert.equal(view.count(), 60, "the last batch is partial only because the results ran out");
  assert.deepEqual(view.hrefs(), view.expectedIds(60));
  assert.equal(view.showMore(), null);
});

test("a revealed batch that the loaded pages cannot fill reads the next page", async (t) => {
  const view = await mount(t, { total: 45, pageSize: 20, hidden: [0, 1, 2, 3], columns: 3 });
  assert.deepEqual(view.reads.filter((cursor) => cursor !== null), ["from-20"], "18 needs the second page when 16 match");
  assert.equal(view.count(), 18);
  await view.press();
  assert.equal(view.count(), 36);
  assert.deepEqual(view.reads.filter((cursor) => cursor !== null), ["from-20"], "36 matching sales are already loaded, so no third read yet");
  assert.equal(new Set(view.hrefs()).size, 36);
  assert.deepEqual(view.hrefs(), view.expectedIds(36));
  await view.press();
  assert.deepEqual(view.reads.filter((cursor) => cursor !== null), ["from-20", "from-40"], "54 needs the third page");
  assert.equal(view.count(), 41, "all 41 matching sales, the last row partial");
  assert.equal(view.showMore(), null);
});

for (const columns of [1, 2, 3]) {
  test(`${columns} column${columns === 1 ? "" : "s"}: 19 results show 18, then all 19`, async (t) => {
    const view = await mount(t, { total: 19, columns });
    assert.equal(view.count(), 18);
    assert.equal(view.count() % columns, 0);
    await view.press();
    assert.equal(view.count(), 19);
    assert.equal(view.showMore(), null);
  });
}

test("a four column grid still ends each batch on a full row", async (t) => {
  const view = await mount(t, { total: 60, columns: 4 });
  assert.equal(view.count(), 20);
  await view.press();
  assert.equal(view.count(), 40);
  await view.press();
  assert.equal(view.count(), 60);
});

test("resizing the grid keeps the order, never duplicates or skips a card, and leaves no placeholder", async (t) => {
  const view = await mount(t, { total: 60, columns: 3 });
  await view.press();
  assert.equal(view.count(), 36);
  for (const columns of [2, 1, 3, 4, 3]) {
    await view.resize(columns);
    const ids = view.hrefs();
    assert.equal(new Set(ids).size, ids.length, `${columns} columns: no duplicates`);
    assert.deepEqual(ids, view.expectedIds(ids.length), `${columns} columns: same order, none skipped`);
    assert.ok(ids.length >= 36, `${columns} columns: nothing revealed is hidden again`);
    assert.equal(ids.length % columns, 0, `${columns} columns: ends on a full row`);
    assert.equal(view.onlyCards(), true);
  }
  await view.press();
  assert.equal(view.count(), 54);
  await view.press();
  assert.equal(view.count(), 60);
  assert.deepEqual(view.hrefs(), view.expectedIds(60));
});

test("Show more stays available when every loaded sale has ended", async (t) => {
  const list = await mount(t, { total: 2, pageSize: 1, hidden: [0], expired: true, columns: 3, layout: "list" });
  assert.deepEqual(list.listIds(), []);
  await list.press();
  await waitFor(() => list.listIds().length === 1, "the live presale from the second page");
  assert.deepEqual(list.listIds(), [idOf(1)]);
  assert.equal(list.showMore(), null);
});
