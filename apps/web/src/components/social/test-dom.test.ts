import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom, testEvent } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();

test("stopImmediatePropagation stops later listeners on the same target and ancestors", () => {
  const parent = document.createElement("div");
  const button = document.createElement("button");
  parent.appendChild(button);
  const calls: string[] = [];
  button.addEventListener("click", (event) => {
    calls.push("first");
    event.stopImmediatePropagation();
  });
  button.addEventListener("click", () => calls.push("second"));
  parent.addEventListener("click", () => calls.push("parent"));
  button.dispatchEvent(testEvent("click"));
  assert.deepEqual(calls, ["first"]);
});

test("stopPropagation keeps later listeners on the same target", () => {
  const button = document.createElement("button");
  const calls: string[] = [];
  button.addEventListener("click", (event) => { calls.push("first"); event.stopPropagation(); });
  button.addEventListener("click", () => calls.push("second"));
  button.dispatchEvent(testEvent("click"));
  assert.deepEqual(calls, ["first", "second"]);
});

test("listener accounting follows duplicate, once and aborted listeners", () => {
  const controller = new AbortController();
  const listener = () => undefined;
  const baseline = document.listeners.count();
  document.addEventListener("check", listener, { once: true });
  document.addEventListener("check", listener, { once: true });
  assert.equal(document.listeners.count(), baseline + 1);
  document.dispatchEvent(testEvent("check"));
  assert.equal(document.listeners.count(), baseline);
  document.addEventListener("check", listener, { signal: controller.signal });
  assert.equal(document.listeners.count(), baseline + 1);
  controller.abort();
  assert.equal(document.listeners.count(), baseline);
});
