import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CoinDetails } from "./CoinDetails";
import { CoinDetailsSlots } from "./panel-context";

test("hiding a panel closes details without remounting their exact draft", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>');
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("mount")!);
  const render = async (visible: boolean) => {
    await act(async () => root.render(
      <CoinDetailsSlots value={{ visible }}>
        <CoinDetails kind="trade" label="Trade details"><input aria-label="Exact draft" defaultValue="0001.2300" /></CoinDetails>
      </CoinDetailsSlots>,
    ));
  };
  try {
    await render(true);
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Trade details"]')!;
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Exact draft"]')!;
    await act(async () => trigger.click());
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    input.value = "0002.3400";
    await render(false);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await render(true);
    assert.equal(trigger.getAttribute("aria-expanded"), "false", "returning to the panel does not reopen details");
    assert.equal(document.querySelector('input[aria-label="Exact draft"]') === input, true);
    assert.equal(input.value, "0002.3400");
    await act(async () => trigger.click());
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
