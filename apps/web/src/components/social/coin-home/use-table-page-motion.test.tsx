import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, recordAnimations, testEvent, waitFor } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const motion = recordAnimations();
const { act, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useTablePageMotion, TABLE_PAGE_SETTLED_EVENT } = await import("./use-table-page-motion");
const { TableFooter } = await import("./TableFooter");

function Board({ page, pending, onRows }: Readonly<{ page: number; pending: boolean; onRows: (next: number) => void }>) {
  const root = useRef<HTMLDivElement>(null);
  useTablePageMotion(root);
  return <div ref={root}><section data-section="coins"><span data-table-surface="" /><ol><li>Coin</li></ol>
    <TableFooter what="coins" page={page} rows={5} pages={3} onRows={onRows} onPage={() => undefined} pending={pending} />
  </section><section data-section="traders"><span data-other="" /></section></div>;
}

test("a slow page animates its committed resize; equal-size completion, viewport resize and unmount drop old measurements", async (t) => {
  let height = 100;
  let resize: () => void = () => undefined;
  let disconnected = false;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  t.mock.property(globalThis, "ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe(element: Element) { if (element.querySelector(":scope > [data-section]")) resize = this.callback; }
    unobserve() {}
    disconnect() { disconnected = true; }
  } as unknown as typeof ResizeObserver);
  t.mock.method(dom.window, "requestAnimationFrame", (run: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, run); return id; });
  t.mock.method(dom.window, "cancelAnimationFrame", (id: number) => { frames.delete(id); });
  t.mock.method(dom.window.Element.prototype, "getBoundingClientRect", function (this: Element) {
    const top = this.hasAttribute("data-table-footer") ? height - 20 : 0;
    return { top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} };
  });
  const container = dom.document.createElement("div"); container.setAttribute("data-blast-ui", ""); dom.document.body.append(container);
  const rows: number[] = [];
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = async (page: number, pending = false) => act(async () => root.render(<Board page={page} pending={pending} onRows={next => rows.push(next)} />));
  const start = async (detail = 1) => act(async () => { container.querySelector('[aria-label="Next page"]')!.dispatchEvent(testEvent("click", { detail })); });
  const frame = () => { const due = [...frames]; frames.clear(); for (const [, run] of due) run(0); };
  await render(1);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  await start();
  await render(2, true);
  assert.equal(frames.size, 0, "pending data cannot complete a page's motion lifecycle");
  await act(async () => { t.mock.timers.tick(20_000); });
  height = 60;
  await render(2);
  resize();
  assert.ok(motion.all.some(animation => animation.keyframes.some(value => value.transform === "scaleY(1)")), "the late answer still animates its real resize");
  assert.equal(frames.size, 0, "ResizeObserver consumed the measurement");
  let count = motion.all.length;
  await start();
  assert.ok(motion.all.every(animation => animation.playState === "idle"), "a new page cancels the interrupted animations");
  height = 65; resize();
  dom.window.dispatchEvent(new dom.window.Event("resize"));
  assert.ok(motion.all.every(animation => animation.playState === "idle"), "viewport changes also cancel running animations");
  count = motion.all.length;
  await start();
  container.querySelector('[data-other]')!.dispatchEvent(new dom.window.CustomEvent(TABLE_PAGE_SETTLED_EVENT, { bubbles: true }));
  assert.equal(frames.size, 0, "another table cannot complete this page");
  await render(1);
  await render(1, true);
  await render(1);
  assert.equal(frames.size, 1, "repeated completion replaces its previous frame");
  await start();
  assert.equal(frames.size, 0, "a new page cancels the preceding completion frame");
  await render(1, true); await render(1);
  frame(); frame();
  height = 80;
  resize();
  assert.equal(motion.all.length, count, "a settled equal-size page cannot animate a later unrelated resize");
  await start();
  dom.window.dispatchEvent(new dom.window.Event("resize"));
  height = 90; resize();
  assert.equal(motion.all.length, count, "viewport changes cancel stale geometry");
  await start();
  await start(0);
  height = 95; resize();
  assert.equal(motion.all.length, count, "keyboard activation cancels an earlier pointer snapshot");
  dom.window.reducedMotion = true;
  await start();
  height = 100; resize();
  assert.equal(motion.all.length, count, "reduced motion does not start geometry animations");
  dom.window.reducedMotion = false;
  const menu = async () => act(async () => { container.querySelector('[aria-label="Coins rows per page: 5 per page"]')!.dispatchEvent(testEvent("click", { detail: 1 })); });
  const option = (label: string) => [...dom.document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent!.includes(label))!;
  await menu();
  await act(async () => option("10 per page").dispatchEvent(testEvent("click", { detail: 1 })));
  assert.deepEqual(rows, [10]);
  const afterPick = motion.all.length;
  height = 105; resize();
  assert.ok(motion.all.length > afterPick, "a rows selection measures before the layout changes");
  motion.finishAll();
  await menu();
  await act(async () => option("20 per page").dispatchEvent(testEvent("keydown", { key: "Enter", code: "Enter" })));
  assert.deepEqual(rows, [10, 20]);
  const afterKeyboardPick = motion.all.length;
  height = 110; resize();
  assert.equal(motion.all.length, afterKeyboardPick, "a keyboard rows selection stays still");
  await start();
  await render(2);
  assert.equal(frames.size, 1);
  await act(async () => root.unmount());
  assert.equal(frames.size, 0);
  assert.equal(disconnected, true);
});

const { QueryClient } = await import("@tanstack/react-query");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { TradersSection } = await import("./TradersSection");
const { PostsSection } = await import("./PostsSection");
const { feedItem, feedPage, FIXTURE_NOW } = await import("../../../../test/fixtures/social/feed-fixtures.ts");
type TradersPage = import("@blast/core/web/contracts/home.ts").HomeTradersPage;

function LiveBoard({ children }: Readonly<{ children: import("react").ReactNode }>) {
  const root = useRef<HTMLDivElement>(null);
  useTablePageMotion(root);
  return <div ref={root}><section data-section="live">{children}</section></div>;
}

const leaderboard = (limit: number): TradersPage => ({
  search: "", page: 1, limit, total: 25, global_total: 25, window: "24h", clock_ms: 1,
  as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 },
  traders: Array.from({ length: limit }, (_, index) => ({
    key: `c:trader${index}`, rank: index + 1,
    actor: { type: "account", callsign: `trader${index}`, display_name: `Trader ${index}`, path: `/@trader${index}`, avatar_url: null, x_handle: null, verified: false },
    followers: null, buys: null, sells: null, commits: null, claims: null, latest_ms: 0, latest_kind: "trade_buy", events_total: 0,
    coins: [], coins_total: 0, holdings: [], portfolio: { public: true, value_usd: "0.00", pnl_usd: "1.00" },
  })),
});

test("live trader rows wait for their answer; failed trader and post pages discard equal-size measurements", async t => {
  let height = 100;
  let resize: () => void = () => undefined;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  t.mock.property(globalThis, "ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe(element: Element) { if (element.querySelector(":scope > [data-section]")) resize = this.callback; }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver);
  t.mock.method(dom.window, "requestAnimationFrame", (run: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, run); return id; });
  t.mock.method(dom.window, "cancelAnimationFrame", (id: number) => { frames.delete(id); });
  t.mock.method(dom.window.Element.prototype, "getBoundingClientRect", function (this: Element) {
    const top = this.hasAttribute("data-table-footer") ? height - 20 : 0;
    return { top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} };
  });
  const pendingReads = new Map<string, (response: Response) => void>();
  t.mock.method(globalThis, "fetch", (path: string) => new Promise<Response>(resolve => { pendingReads.set(path, resolve); }));
  const answer = async (matches: (path: string) => boolean, response: Response) => {
    const path = await waitFor(() => [...pendingReads.keys()].find(matches), "the requested page read");
    const resolve = pendingReads.get(path)!;
    pendingReads.delete(path);
    await act(async () => resolve(response));
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = dom.document.createElement("div"); container.setAttribute("data-blast-ui", ""); dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });
  const frame = () => { const due = [...frames]; frames.clear(); for (const [, run] of due) run(0); };
  const click = (button: Element) => act(async () => { button.dispatchEvent(testEvent("click", { detail: 1 })); });
  const pick = async (label: string) => {
    await click(container.querySelector('[aria-label^="Traders rows per page"]')!);
    await click([...dom.document.querySelectorAll('[role="menuitemradio"]')].find(option => option.textContent!.includes(label))!);
    await waitFor(() => container.querySelector('[aria-busy="true"]'), "pending trader rows");
  };
  await act(async () => root.render(<QueryProvider client={client}><LiveBoard><TradersSection initial={leaderboard(5)} initialMs={Date.now()} window="24h" nowMs={1} /></LiveBoard></QueryProvider>));
  await pick("10 per page");
  frame(); frame();
  const beforeAnswer = motion.all.length;
  assert.equal(container.querySelectorAll('ol[aria-label="PnL leaderboard"] > li').length, 5);
  await answer(path => path.includes("/traders"), Response.json(leaderboard(10)));
  await waitFor(() => container.querySelectorAll('ol[aria-label="PnL leaderboard"] > li').length === 10, "ten answered traders");
  assert.equal(container.querySelectorAll('ol[aria-label="PnL leaderboard"] > li').length, 10);
  height = 150; resize();
  assert.ok(motion.all.length > beforeAnswer, "delayed row-count answers retain their pointer measurement");
  await pick("20 per page");
  await answer(path => path.includes("/traders"), new Response("{}", { status: 503 }));
  await waitFor(() => container.textContent?.includes("Traders couldn’t load"), "trader failure");
  assert.match(container.textContent!, /Traders couldn’t load/);
  assert.equal(container.querySelector('[data-table-footer]'), null);
  frame(); frame();
  const failedTrader = motion.all.length;
  height = 160; resize();
  assert.equal(motion.all.length, failedTrader, "a removed error footer completes even an equal-height answer");
  const initial = feedPage({ items: Array.from({ length: 5 }, (_, index) => feedItem({ entry_id: `a:${5000 - index}:1:0:0` })) });
  await act(async () => root.render(<QueryProvider client={client}><LiveBoard><PostsSection initial={initial} nowMs={FIXTURE_NOW} /></LiveBoard></QueryProvider>));
  await click(container.querySelector('[aria-label="Next page"]')!);
  await waitFor(() => container.querySelector('[aria-busy="true"]'), "pending posts");
  frame(); frame();
  await answer(path => path.includes("cursor=cursor-1"), new Response("{}", { status: 503 }));
  await waitFor(() => container.textContent?.includes("Posts couldn’t load"), "post failure");
  assert.match(container.textContent!, /Posts couldn’t load/);
  assert.equal(container.querySelector('[aria-current="page"]')?.textContent, "1");
  frame(); frame();
  const failedPost = motion.all.length;
  height = 170; resize();
  assert.equal(motion.all.length, failedPost, "a failed next page cannot animate an unrelated later resize");
});
