import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { escapeInDiscover } from "./discover-escape";

test("Escape in Discover: a checkbox closes, a search with text clears first and closes next, a closed select closes, an IME Escape and a read-only field are never cleared", async () => {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  const { act, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  let search = "pepe";
  function Fields() {
    const [value, setValue] = useState(search);
    search = value;
    return <>
      <input aria-label="Hide small" type="checkbox" defaultChecked />
      <input aria-label="Search" type="search" value={value} onChange={event => setValue(event.currentTarget.value)} />
      <input aria-label="Locked" type="search" readOnly value="kept" />
      <select aria-label="More views"><option>Portfolio</option></select>
    </>;
  }
  const root = createRoot(dom.window.document.getElementById("mount")!);
  try {
    await act(async () => root.render(<Fields />));
    const doc = dom.window.document;
    const escape = async (label: string, init: KeyboardEventInit = {}) => {
      const field = doc.querySelector(`[aria-label="${label}"]`)!;
      let result!: ReturnType<typeof escapeInDiscover>;
      field.addEventListener("keydown", event => { result = escapeInDiscover(event as KeyboardEvent); }, { once: true });
      await act(async () => { field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, ...init })); });
      return result;
    };
    assert.equal(await escape("Hide small"), "close", "a checkbox's value is always \"on\", never text to clear");
    // Safari reports an IME's candidate-cancelling Escape as keyCode 229, sometimes after composition has ended.
    assert.equal(await escape("Search", { keyCode: 229 }), "keep");
    assert.equal(await escape("Search", { isComposing: true }), "keep");
    assert.equal(search, "pepe", "an IME Escape never clears committed text");
    assert.equal(await escape("Search"), "cleared");
    assert.equal(search, "", "the controlled search state is cleared, not just the DOM value");
    assert.equal(await escape("Search"), "close", "the next Escape closes Discover");
    assert.equal(await escape("Locked"), "close", "a read-only field is never cleared");
    assert.equal(doc.querySelector<HTMLInputElement>('[aria-label="Locked"]')!.value, "kept");
    assert.equal(await escape("More views"), "close", "a closed select closes Discover; an open list takes Escape before the page sees it");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
