import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";
import { FIXTURE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { TSUI } from "../../../../test/fixtures/social/commit/alon.ts";
import { PaymentCoinSelector } from "./PaymentCoinSelector";

const css = ["../../blast-ui/blast-ui.css", "../coins/coins.module.css", "./commit.module.css"]
  .map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");

// jsdom verifies the real markup's style wiring; browser QA checks flex layout and scrolling.
test("USDC and TSUI payment controls bound the chevron separately from token artwork and show the symbol alone", () => {
  const client = createTestQueryClient();
  try {
    for (const purchase of [false, true]) {
      for (const selected of [FIXTURE_COINS[0]!, TSUI]) {
        const html = renderToStaticMarkup(withQueryClient(client,
          <PaymentCoinSelector accepted={selected} busy={false} coins={[]} onPick={() => undefined} purchase={purchase} selected={{ ...selected, name: "A very long payment coin name ".repeat(10) }} />));
        const dom = new JSDOM(`<div data-blast-ui>${html}</div>`);
        try {
          const style = dom.window.document.createElement("style");
          style.textContent = css;
          dom.window.document.head.append(style);
          const button = dom.window.document.querySelector("button")!;
          const computed = (element: Element) => dom.window.getComputedStyle(element);
          assert.equal(computed(button).display, "inline-flex");
          assert.equal(computed(button).height, "44px");
          assert.equal(computed(button).alignItems, "center");
          const chevron = button.querySelector('[data-ui-chevron]')!;
          assert.equal(chevron.getAttribute("aria-hidden"), "true");
          assert.equal(button.querySelectorAll('[data-ui-chevron]').length, 1);
          assert.equal(button.getAttribute("data-ui-disclosure"), "");
          assert.ok(chevron.querySelector("svg"));
          assert.equal(computed(button.querySelector("[data-coin-mark]")!).width, "28px");
          // The field names the coin once, by its symbol ("SUI", never "SUI Sui"), however long its full name.
          assert.equal(button.querySelector(".identityText > span"), null);
          assert.equal(button.querySelector(".identityText")!.textContent, selected.symbol);
        } finally {
          dom.window.close();
        }
      }
    }
  } finally {
    client.clear();
  }
});

test("the shared picker search frame cannot shrink when its results fill the sheet", () => {
  const dom = new JSDOM('<div data-blast-ui><div class="tpSearch"><span><svg></svg></span><input aria-label="Search coins"></div></div>');
  try {
    const style = dom.window.document.createElement("style");
    style.textContent = css;
    dom.window.document.head.append(style);
    const wrapper = dom.window.getComputedStyle(dom.window.document.querySelector(".tpSearch")!);
    // The frame is the shared FieldGroup (edge, focus and input padding live in Controls.module.css); the picker owns only its height.
    assert.equal(wrapper.minHeight, "48px");
    assert.equal(wrapper.flexShrink, "0");
    assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector("svg")!).width, "18px");
  } finally {
    dom.window.close();
  }
});
