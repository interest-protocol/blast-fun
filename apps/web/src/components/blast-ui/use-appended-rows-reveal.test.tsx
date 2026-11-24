import assert from "node:assert/strict";
import test from "node:test";
import type { LoadMoreRows } from "./use-appended-rows-reveal";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppendedRowsReveal } = await import("./use-appended-rows-reveal");

function List({ ids, load }: { ids: string[]; load: LoadMoreRows }) {
  const { listRef, more } = useAppendedRowsReveal(ids, load);
  return <section ref={listRef}>{ids.map(id => <a key={id} data-row-id={id} href={`#${id}`}>{id}</a>)}
    <button onClick={() => void more()}>More</button></section>;
}

test("only manual response IDs fade once, preserving existing DOM, focus, and immediate links", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const animated: HTMLElement[] = [];
  t.mock.method(window.HTMLElement.prototype, "animate", function (this: HTMLElement) {
    animated.push(this);
    return { cancel() {} };
  });
  let resolve!: (ids: string[]) => void;
  const load: LoadMoreRows = received => new Promise<void>(done => { resolve = ids => { received(ids); done(); }; });
  const render = (ids: string[]) => root.render(<List ids={ids} load={load} />);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); delete document.documentElement.dataset.blastInput; });
  await act(async () => render(["first"]));
  const first = container.querySelector("a")!;
  const button = container.querySelector("button")!;
  button.focus();
  await act(async () => button.click());
  await act(async () => render(["background", "first"]));
  assert.equal(animated.length, 0);
  await act(async () => { resolve(["background", "first", "second", "third"]); });
  assert.equal(animated.length, 0, "promise can settle before rows commit");
  await act(async () => render(["background", "first", "second", "third"]));
  assert.deepEqual(animated.map(row => row.dataset.rowId), ["second", "third"]);
  assert.equal(container.querySelector('[data-row-id="first"]'), first);
  assert.equal(document.activeElement, button);
  assert.equal(container.querySelector('[data-row-id="second"]')?.getAttribute("href"), "#second");
  await act(async () => render(["restored", "background", "first", "second", "third"]));
  assert.equal(animated.length, 2);
  document.documentElement.dataset.blastInput = "keyboard";
  await act(async () => button.click());
  await act(async () => { render(["first", "second", "third", "keyboard"]); resolve(["keyboard"]); });
  assert.equal(animated.length, 2);
  delete document.documentElement.dataset.blastInput;
  t.mock.method(window, "matchMedia", () => ({ matches: true }));
  await act(async () => button.click());
  await act(async () => { render(["first", "reduced"]); resolve(["reduced"]); });
  assert.equal(animated.length, 2);
});

test("an unmounted request cannot reveal rows in a replacement list", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let resolve!: (ids: string[]) => void;
  let calls = 0;
  t.mock.method(window.HTMLElement.prototype, "animate", () => { calls++; return { cancel() {} }; });
  await act(async () => root.render(<List ids={["first"]} load={received => new Promise<void>(done => { resolve = ids => { received(ids); done(); }; })} />));
  await act(async () => container.querySelector("button")!.click());
  await act(async () => root.unmount());
  await act(async () => resolve(["late"]));
  assert.equal(calls, 0);
  container.remove();
});

test("page rows can commit before the loader settles without missing or repeating feedback", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const animated: string[] = [];
  t.mock.method(window.HTMLElement.prototype, "animate", function (this: HTMLElement) {
    animated.push(this.dataset.rowId!);
    return { cancel() {} };
  });
  let receive!: (ids: readonly string[]) => void;
  let finish!: () => void;
  const load: LoadMoreRows = received => { receive = received; return new Promise<void>(done => { finish = done; }); };
  const render = (ids: string[]) => root.render(<List ids={ids} load={load} />);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => render(["first"]));
  await act(async () => container.querySelector("button")!.click());
  await act(async () => render(["first", "background"]));
  await act(async () => receive(["background", "second"]));
  await act(async () => render(["first", "background", "second"]));
  assert.deepEqual(animated, ["second"]);
  await act(async () => finish());
  await act(async () => render(["first", "background", "second"]));
  assert.deepEqual(animated, ["second"]);
});
