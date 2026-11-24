import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { bindSheetViewport } from "./sheet-viewport";

test("sheet follows keyboard resize and viewport pan, then releases styles and listeners", () => {
  const dom = new JSDOM('<div id="scrim"></div>');
  const scrim = dom.window.document.getElementById("scrim")!;
  const viewport = Object.assign(new EventTarget(), { height: 700, offsetTop: 0 });
  const release = bindSheetViewport(scrim, viewport as VisualViewport);
  assert.equal(scrim.style.height, "700px");
  viewport.height = 350;
  viewport.dispatchEvent(new Event("resize"));
  assert.equal(scrim.style.getPropertyValue("--sheet-viewport-height"), "350px");
  viewport.offsetTop = 80;
  viewport.dispatchEvent(new Event("scroll"));
  assert.equal(scrim.style.top, "80px");
  assert.equal(scrim.style.bottom, "auto");
  release();
  viewport.dispatchEvent(new Event("resize"));
  assert.equal(scrim.getAttribute("style"), "");
  dom.window.close();
});
