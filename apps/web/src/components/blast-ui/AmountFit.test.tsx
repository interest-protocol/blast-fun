import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "react-dom/server";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";
import { StyleNonceContext } from "../ui-libraries/style-nonce.tsx";
import { AmountFit } from "./AmountFit.tsx";

const dom = installTestDom();

test("empty and prefilled trade amounts have separate widths before hydration under production CSP", () => {
  const nonce = "amountTestNonce0123456789abcdef";
  const container = dom.document.createElement("div");
  container.innerHTML = renderToString(
    <StyleNonceContext value={nonce}>
      <AmountFit value=""><input aria-label="Amount to pay" /></AmountFit>
      <AmountFit value="1,234.56"><b>1,234.56</b></AmountFit>
    </StyleNonceContext>,
  );
  // Enforce production's style policy in this DOM fixture.
  for (const el of container.querySelectorAll("[style]")) el.removeAttribute("style");
  for (const sheet of container.querySelectorAll("style")) {
    if (sheet.nonce !== nonce) sheet.remove();
  }
  dom.document.body.append(container);
  try {
    const emWidth = (tag: string) => dom.window.getComputedStyle(container.querySelector(tag)!.parentElement!).getPropertyValue("--amount-em-width").trim();
    assert.equal(Number(emWidth("input")), 1);
    assert.ok(Number(emWidth("b")) > 4);
  } finally {
    container.remove();
  }
});
