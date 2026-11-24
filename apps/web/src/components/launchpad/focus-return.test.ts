import assert from "node:assert/strict";
import test from "node:test";

import { captureFocusReturn, handOffFocus } from "./focus-return.ts";

type FakeDocument = { activeElement: FakeElement | null };

class FakeElement {
  isConnected = true;
  visible = true;
  readonly doc: FakeDocument;
  constructor(doc: FakeDocument) {
    this.doc = doc;
  }
  checkVisibility() {
    return this.visible;
  }
  focus() {
    this.doc.activeElement = this;
  }
}

test("closing a focus surface returns focus to the control that opened it", () => {
  const doc: FakeDocument = { activeElement: null };
  const trigger = new FakeElement(doc);
  const insideSurface = new FakeElement(doc);
  trigger.focus();

  const restore = captureFocusReturn(doc);
  insideSurface.focus();
  restore(null);

  assert.equal(doc.activeElement, trigger);
});

test("focus falls back when the opening control has left the page", () => {
  const doc: FakeDocument = { activeElement: null };
  const trigger = new FakeElement(doc);
  const fallback = new FakeElement(doc);
  trigger.focus();

  const restore = captureFocusReturn(doc);
  trigger.isConnected = false;
  restore(fallback);

  assert.equal(doc.activeElement, fallback);
});

test("focus skips a hidden opener and a hidden fallback for the first visible fallback", () => {
  // Crossing to desktop with mobile Trade open hides the Trade button, which
  // is both the opener and the first fallback; the desktop rail takes focus.
  const doc: FakeDocument = { activeElement: null };
  const tradeButton = new FakeElement(doc);
  const rail = new FakeElement(doc);
  tradeButton.focus();

  const restore = captureFocusReturn(doc);
  tradeButton.visible = false;
  restore(tradeButton, rail);

  assert.equal(doc.activeElement, rail);
});

test("focus inside a region that is leaving the page moves to its replacement", () => {
  // Crossing to mobile with focus in the desktop Trade rail: the rail is
  // removed and the mobile Trade button takes focus instead of the page body.
  const doc: FakeDocument = { activeElement: null };
  const railControl = new FakeElement(doc);
  const tradeButton = new FakeElement(doc);
  const rail = { contains: (node: unknown) => node === railControl };
  railControl.focus();

  handOffFocus(doc, rail, tradeButton);
  assert.equal(doc.activeElement, tradeButton);

  const elsewhere = new FakeElement(doc);
  elsewhere.focus();
  handOffFocus(doc, rail, tradeButton);
  assert.equal(doc.activeElement, elsewhere, "focus outside the region stays put");
});
