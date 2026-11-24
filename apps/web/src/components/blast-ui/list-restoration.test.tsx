import assert from "node:assert/strict";
import test from "node:test";
import { useState, type ReactNode } from "react";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const { captureLists, savedList, saveListContent, useListContent, useListOrigin, useListRestoration, useListTraversal } = await import("./list-restoration");
const frame = () => act(async () => { await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))); });

test("history entries restore multiple expansions, loaded pages, focus and a nested scroll anchor once", async t => {
  const container = document.createElement("div");
  container.style.overflowY = "auto";
  Object.defineProperties(container, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } });
  document.body.append(container);
  const rect = (top: number) => ({ top, bottom: top + 100, left: 0, right: 400, width: 400, height: 100, x: 0, y: top, toJSON: () => ({}) });
  container.getBoundingClientRect = () => rect(40);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); window.history.replaceState(null, "", "/"); });
  const first = { expanded: ["a", "b"], rows: ["a", "b", "c"], search: "sale", page: 2 };
  const second = { expanded: ["c"], rows: ["c"], search: "other", page: 1 };
  const restoredHref = "/presale/b";
  let change: (value: typeof first) => void = () => {};
  function List() {
    const [value, setValue] = useState(second);
    change = setValue;
    const ref = useListRestoration("catalog:reader", value, setValue);
    return <div ref={ref} data-page={value.page}>
      {value.rows.includes("b") ? <div data-visual-copy inert><a data-list-row="b" href={restoredHref}>Copy of b</a></div> : null}
      {value.rows.map(id => <div data-list-row={id} data-expanded={value.expanded.includes(id)} key={id} ref={node => { if (node) node.getBoundingClientRect = () => rect(500 - container.scrollTop); }}><a href={`/presale/${id}`}>{id}</a></div>)}
    </div>;
  }
  window.history.replaceState({
    __NA: true,
    blastLists: {
      "catalog:reader": { value: first, position: { top: 0, left: 0, row: null, offset: 0, focus: null } },
    },
  }, "", "/presale?sort=backed");
  await act(async () => root.render(<List />));
  await frame();
  assert.equal(container.querySelector("[data-page]")?.getAttribute("data-page"), "2");
  container.scrollTop = 450;
  container.querySelector<HTMLAnchorElement>('div[data-list-row="b"] a')!.focus();
  captureLists();
  const entryA = structuredClone(window.history.state);
  assert.equal(entryA.__NA, true, "Next's history fields survive capture");
  assert.deepEqual(savedList<typeof first>("catalog:reader")?.value, first);
  window.history.pushState({}, "", "/presale?status=ended");
  await act(async () => change(second));
  container.scrollTop = 120;
  captureLists();
  const entryB = structuredClone(window.history.state);
  await act(async () => {
    window.history.replaceState(entryA, "", "/presale?sort=backed");
    window.dispatchEvent(new window.PopStateEvent("popstate", { state: entryA }));
  });
  await frame();
  assert.equal(container.querySelector("[data-page]")?.getAttribute("data-page"), "2");
  assert.equal(container.querySelectorAll('[data-expanded="true"]').length, 2);
  assert.equal(container.scrollTop, 450);
  assert.equal(document.activeElement?.getAttribute("href"), restoredHref);
  assert.equal(document.activeElement?.textContent, "b", "focus returns to the original row");
  container.scrollTop = 470;
  container.querySelector("[data-page]")!.append(document.createElement("span"));
  await frame();
  assert.equal(container.scrollTop, 470, "a later background update never replays restoration");
  await act(async () => {
    window.history.replaceState(entryB, "", "/presale?status=ended");
    window.dispatchEvent(new window.PopStateEvent("popstate", { state: entryB }));
  });
  await frame();
  assert.equal(container.querySelectorAll("[data-list-row]").length, 1);
  assert.equal(container.scrollTop, 120);
  assert.deepEqual(savedList<typeof first>("catalog:reader")?.value, second);
});

test("a router refresh keeps the list origin without giving it to another entry for the same coin", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
  });

  function Coin({ version }: Readonly<{ version: number }>) {
    return <span data-version={version}>{useListOrigin("coin") ?? "Browse"}</span>;
  }

  const from = new URL("/bonding", window.location.href).href;
  window.history.replaceState({}, "", "/coin/example");
  window.history.pushState({ blastOrigin: from, blastOriginEntry: "source-entry" }, "");
  await act(async () => root.render(<Coin version={1} />));
  assert.equal(container.textContent, from);

  window.history.replaceState({ __NA: true }, "");
  await act(async () => root.render(<Coin version={2} />));
  assert.deepEqual(window.history.state, { __NA: true, blastOrigin: from, blastOriginEntry: "source-entry" });

  await act(async () => {
    window.history.back();
    await new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
  });
  assert.equal(container.textContent, "Browse");
});

test("a list can restore the browser's back entry after the router replaces its state", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
  });

  function List() {
    const [search, setSearch] = useState("");
    const ref = useListRestoration("bonding:public", search, setSearch);
    return <div ref={ref}>{search}</div>;
  }
  function Coin() {
    return <span>{useListOrigin("coin")}</span>;
  }

  window.history.replaceState({
    blastLists: {
      "bonding:public": {
        value: "Blasty",
        position: { top: 0, left: 0, row: null, offset: 0, focus: null },
      },
    },
  }, "", "/bonding");
  window.history.pushState({ blastOrigin: window.location.href }, "", "/coin/example");
  await act(async () => root.render(<Coin />));
  await act(async () => {
    window.history.back();
    await new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    window.history.replaceState({ __NA: true }, "");
    root.render(<List />);
  });
  assert.equal(container.textContent, "Blasty");
  assert.equal(savedList<string>("bonding:public")?.value, "Blasty");
});

test("Home ignores an old snapshot on reload and restores its latest state on repeated Back from a detail page", async (t) => {
  const container = document.createElement("div");
  container.style.overflowY = "auto";
  Object.defineProperties(container, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } });
  document.body.append(container);
  const root = createRoot(container);
  const mountBackDestination = () => {
    // The router can mount Home and replace its history state before the shell observes popstate.
    window.history.replaceState({ __NA: true }, "");
    flushSync(() => render(<Home loading />));
  };
  window.addEventListener("popstate", mountBackDestination, { capture: true, once: true });
  Object.defineProperty(window.performance, "getEntriesByType", { configurable: true, value: () => [{ type: "reload", name: window.location.href }] });
  t.after(async () => {
    window.removeEventListener("popstate", mountBackDestination, true);
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(window.performance, "getEntriesByType");
    window.history.replaceState(null, "", "/");
  });

  const detailHref = "/coin/bcat";
  const isHome = (path: string) => path === "/";
  function Shell({ children }: Readonly<{ children: ReactNode }>) {
    useListTraversal(isHome);
    return children;
  }
  const render = (page: ReactNode) => root.render(<Shell>{page}</Shell>);

  function OrderedCoins() {
    const [order, setOrder] = useState<readonly string[]>([]);
    useListContent("home:coins", order, setOrder);
    return <output>{order.join(", ")}</output>;
  }
  function Home({ loading, previewBusy = false }: { loading: boolean; previewBusy?: boolean }) {
    const [preview, setPreview] = useState<string | null>(null);
    const ref = useListRestoration("home:reader", preview, setPreview, { restoreOnMount: "history-traversal" });
    return <div ref={ref}>
      <OrderedCoins />
      {loading ? <div aria-busy="true" /> : <>
        <a aria-expanded={preview === "BCAT"} data-list-row="bcat" href={detailHref} ref={(row) => {
          if (row) row.getBoundingClientRect = () => new window.DOMRect(0, 320 - container.scrollTop, 400, 200);
        }}>BCAT</a>
        <button onClick={() => setPreview((current) => current ? null : "BCAT")}>Toggle BCAT</button>
        {previewBusy ? <div aria-busy="true" /> : null}
      </>}
    </div>;
  }
  function Detail() {
    return <span>{useListOrigin("bcat")}</span>;
  }

  window.history.replaceState({
    blastLists: { "home:reader": { value: "BCAT", position: { top: 0, left: 0, row: "bcat", offset: 100, focus: "/coin/bcat" } } },
    blastListContent: { "home:coins": ["BCAT"] },
  }, "", "/?src=watchlist&page=2");
  container.scrollTop = 320;
  await act(async () => render(<Home loading />));
  await act(async () => render(<Home loading={false} />));
  await frame();
  const coin = () => container.querySelector<HTMLAnchorElement>('a[href="/coin/bcat"]');
  assert.equal(coin()?.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, document.body);
  assert.equal(container.scrollTop, 320);
  assert.equal(savedList<string | null>("home:reader")?.value, null);

  container.scrollTop = 220;
  coin()?.focus();
  await act(async () => container.querySelector("button")!.click());
  saveListContent("home:coins", ["BCAT"]);
  window.history.pushState({ blastOrigin: window.location.href }, "", "/coin/bcat");
  container.scrollTop = 320;
  await act(async () => render(<Detail />));
  await act(async () => {
    const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    window.history.back();
    await popped;
  });
  await frame();
  assert.equal(container.scrollTop, 320, "the scroll anchor waits for the row");
  await act(async () => render(<Home loading={false} previewBusy />));
  await frame();
  assert.equal(coin()?.getAttribute("aria-expanded"), "true");
  assert.equal(container.querySelector("output")?.textContent, "BCAT");
  assert.equal(container.scrollTop, 320, "loading preview content still holds the scroll anchor");
  await act(async () => container.querySelector("button")!.click());
  assert.equal(savedList<string | null>("home:reader")?.value, null, "closing a preview saves while its content is busy");
  await act(async () => render(<Home loading={false} />));
  await frame();
  assert.equal(document.activeElement, coin());
  assert.equal(container.scrollTop, 220);

  container.scrollTop = 180;
  // Forward can leave before the browser dispatches scrollend.
  container.dispatchEvent(new window.Event("scroll"));
  await act(async () => {
    const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    window.history.forward();
    await popped;
    render(<Detail />);
  });
  container.scrollTop = 0;
  await act(async () => {
    const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    window.history.back();
    await popped;
    render(<Home loading={false} />);
  });
  await frame();
  assert.equal(coin()?.getAttribute("aria-expanded"), "false");
  assert.equal(container.scrollTop, 180);

  await act(async () => render(<Detail />));
  window.history.pushState({}, "", "/?src=following");
  await act(async () => render(<Home loading={false} />));
  await frame();
  await act(async () => container.querySelector("button")!.click());
  await act(async () => {
    const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    window.history.back();
    await popped;
    render(<Detail />);
  });
  await act(async () => {
    const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    window.history.forward();
    await popped;
    render(<Home loading={false} />);
  });
  await frame();
  assert.equal(coin()?.getAttribute("aria-expanded"), "true");
});
