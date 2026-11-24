import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Segmented } = await import("#web/components/blast-ui/Segmented.tsx");

test("presale tabs follow desktop-to-mobile resize without changing selection", async (t) => {
  let width = 355;
  let left = 358;
  const observed = new Set<Element>();
  let resize = () => {};
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resize = () => callback([...observed].map((target) => ({
        target, contentRect: target.getBoundingClientRect(), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
      })), this);
    }
    observe(target: Element) { observed.add(target); }
    unobserve(target: Element) { observed.delete(target); }
    disconnect() { observed.clear(); }
  };
  t.mock.getter(HTMLElement.prototype, "offsetWidth", () => width);
  t.mock.getter(HTMLElement.prototype, "offsetLeft", () => left);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<Segmented label="Price history" options={[["24h", "24H"], ["launch", "Since launch"]]} size="sm" value="launch" onChange={() => {}} />); });
    const thumb = container.querySelector<HTMLElement>(".seg-ind")!;
    assert.equal(thumb.style.width, "355px");
    assert.equal(thumb.style.transform, "translateX(358px)");
    width = 157;
    left = 160;
    await act(async () => { resize(); });
    assert.equal(thumb.style.width, "157px", "the thumb must shrink with its selected button");
    assert.equal(thumb.style.transform, "translateX(160px)");
    assert.equal(container.querySelector('[aria-pressed="true"]')?.textContent, "Since launch");
    width = 355;
    left = 358;
    await act(async () => { resize(); });
    assert.equal(thumb.style.width, "355px");
    assert.equal(thumb.style.transform, "translateX(358px)");
  } finally {
    await act(async () => { root.unmount(); });
    assert.equal(observed.size, 0, "unmount releases the observation");
    container.remove();
    globalThis.ResizeObserver = original;
  }
});
