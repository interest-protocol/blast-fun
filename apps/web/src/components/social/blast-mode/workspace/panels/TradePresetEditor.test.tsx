import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, recordAnimations, setInputValue } from "../../../../../../test/fixtures/social/test-dom.ts";
import { DEFAULT_TRADE_PRESETS, TRADE_PRESETS_KEY } from "./trade-presets.ts";

const dom = installTestDom();
Object.defineProperty(dom.document, "oninput", { value: null, writable: true, configurable: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TradePresetEditor } = await import("./TradePresetEditor.tsx");

test("sell presets let a phone keyboard enter Max after editing a percentage", async () => {
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TradePresetEditor presets={DEFAULT_TRADE_PRESETS} disabled={false} />));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const input = dom.document.querySelector<HTMLInputElement>('[aria-label="Sell preset 4"]')!;
    assert.equal(input.inputMode, "text", "Max needs alphabetic keys on a phone");
    assert.match(dom.document.getElementById(input.getAttribute("aria-describedby")!)!.textContent!, /or max/);
    for (const value of ["75", "Max"]) {
      await act(async () => {
        setInputValue(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    }
    await act(async () => dom.document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    assert.equal(JSON.parse(dom.window.localStorage.getItem(TRADE_PRESETS_KEY)!).sell[3], "max");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.localStorage.clear();
  }
});

test("Trade settings names a bad preset under its field, caps its length, picks slippage on the segmented control, and Escape keeps unsaved edits behind Undo (audit F14)", async () => {
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  const saved: number[] = [];
  try {
    await act(async () => root.render(<TradePresetEditor presets={DEFAULT_TRADE_PRESETS} disabled={false} settings={{ slippage_bps: 50, onSave: bps => saved.push(bps) }} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Trade settings"]')!.click());
    assert.equal(dom.document.querySelector("select"), null, "no native select");
    const input = dom.document.querySelector<HTMLInputElement>('[aria-label="Buy preset 2"]')!;
    assert.equal(input.maxLength, 12);
    await act(async () => {
      setInputValue(input, "12x");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(input.getAttribute("aria-invalid"), null, "no error while typing");
    await act(async () => input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })));
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(dom.document.getElementById(input.getAttribute("aria-errormessage")!)!.textContent, "Number or max");
    await act(async () => [...dom.document.querySelectorAll<HTMLButtonElement>('[aria-label="Slippage"] button')].find(button => button.textContent === "1%")!.click());
    await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    assert.match(container.textContent!, /Settings not saved/);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Undo")!.click());
    assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="Buy preset 2"]')!.value, "12x", "Undo brings the edits back");
    assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="Buy preset 2"]')!.getAttribute("aria-invalid"), "true", "restored problems show at once");
    assert.equal(dom.document.querySelector('[aria-label="Slippage"] [aria-pressed="true"]')!.textContent, "1%");
    assert.deepEqual(saved, []);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.localStorage.clear();
  }
});

test("while Settings not saved shows, the gear reopens the unsaved edits, Undo takes focus, and Reset presets has its own Undo (audit F14)", async () => {
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  const buy = () => dom.document.querySelector<HTMLInputElement>('[aria-label="Buy preset 1"]')!;
  const button = (text: string) => [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(each => each.textContent === text);
  const motion = recordAnimations();
  try {
    await act(async () => root.render(<TradePresetEditor presets={DEFAULT_TRADE_PRESETS} disabled={false} settings={{ slippage_bps: 50, onSave: () => {} }} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Trade settings"]')!.click());
    await act(async () => {
      setInputValue(buy(), "77");
      buy().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    await act(async () => motion.finishAll());
    assert.equal(dom.document.activeElement?.textContent, "Undo", "the keyboard lands on Undo");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Trade settings"]')!.click());
    assert.equal(buy().value, "77", "the gear brings back the unsaved edits, not the saved values");
    await act(async () => {
      setInputValue(buy(), "0");
      buy().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => button("Reset presets")!.click());
    assert.equal(buy().value, DEFAULT_TRADE_PRESETS.buy[0]);
    await act(async () => button("Undo reset")!.click());
    assert.equal(buy().value, "0");
    assert.equal(buy().getAttribute("aria-invalid"), "true", "the restored bad value shows its error at once");
    assert.ok(button("Reset presets"), "Reset comes back once undone");
    await act(async () => {
      setInputValue(buy(), DEFAULT_TRADE_PRESETS.buy[0]!);
      buy().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => button("Reset presets")!.click());
    assert.equal(button("Undo reset"), undefined, "resetting presets that are already the defaults offers no Undo");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.localStorage.clear();
  }
});
