import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { tradeShortcut } from "./trade-shortcuts";

test("trade chords target visible enabled controls; typed digits stay literal and submit works only from the ticket amount", () => {
  const dom = new JSDOM('<section id="panel"><input data-panel-amount><input id="search"><button data-side="buy"></button><button data-side="sell"></button><button data-trade-preset="1"></button><button data-trade-preset="4"></button><button data-coin-submit></button></section>');
  Object.assign(globalThis, { Element: dom.window.Element });
  const panel = dom.window.document.getElementById("panel")!;
  for (const button of panel.querySelectorAll("button")) button.getClientRects = () => [{ width: 40 }] as unknown as DOMRectList;
  function resolve(key: string, target: Element = panel, shiftKey = false) {
    let result: HTMLButtonElement | null = null;
    target.addEventListener("keydown", event => { result = tradeShortcut(event as KeyboardEvent, panel); }, { once: true });
    target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, code: key === " " ? "Space" : "", shiftKey }));
    return result as HTMLButtonElement | null;
  }
  try {
    assert.equal(resolve("q")?.dataset.side, "buy");
    assert.equal(resolve("e")?.dataset.side, "sell");
    assert.equal(resolve("1")?.dataset.tradePreset, "1");
    assert.equal(resolve("4")?.dataset.tradePreset, "4");
    assert.equal(resolve(" ", panel, true)?.hasAttribute("data-coin-submit"), true);
    const amount = panel.querySelector("input")!;
    for (const key of ["q", "e", "1", "4", "Enter"]) assert.equal(resolve(key, amount), null);
    assert.equal(resolve(" ", amount, true)?.hasAttribute("data-coin-submit"), true);
    assert.equal(resolve(" ", panel.querySelector("#search")!, true), null);
    assert.equal(resolve("q", panel, true), null);
    panel.querySelector<HTMLButtonElement>("[data-coin-submit]")!.disabled = true;
    assert.equal(resolve(" ", amount, true), null);
    panel.hidden = true;
    assert.equal(resolve("q"), null);
  } finally { dom.window.close(); }
});
