import assert from "node:assert/strict";
import { test } from "node:test";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ReviewIdentifier } = await import("./ReviewIdentifier");

test("all roles and coin types copy full values, announce success and honestly recover from failure", async (t) => {
  const container = document.createElement("form");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const writes: string[] = [];
  let fail = false;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => {
    if (fail) throw new Error("Permission denied");
    writes.push(value);
  } } });
  let submits = 0;
  container.onsubmit = (event) => { event.preventDefault(); submits++; };
  for (const label of ["Recipient wallet", "Refund wallet", "Who can cancel", "Coin type"]) {
    const value = `0x${"a".repeat(64)}${label === "Coin type" ? "::module::CompleteStruct" : ""}`;
    await act(async () => root.render(<ReviewIdentifier key={label} label={label} value={value} coinType={label === "Coin type"} />));
    const button = container.querySelector<HTMLButtonElement>("button[aria-label^=\"Copy\"]")!;
    assert.ok(button.getAttribute("aria-label")?.includes(label === "Coin type" ? "coin type" : label === "Who can cancel" ? "cancellation authority" : label.toLowerCase().replace(" wallet", "")));
    assert.equal(button.type, "button");
    const disclosure = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    assert.equal(disclosure.getAttribute("aria-label"), `Show full ${label.toLowerCase()}`);
    assert.equal(disclosure.getAttribute("aria-expanded"), "false");
    await act(async () => disclosure.click());
    assert.equal(disclosure.getAttribute("aria-expanded"), "true");
    const panel = document.getElementById(disclosure.getAttribute("aria-controls")!)!;
    assert.equal(panel.querySelector("code")?.textContent, value);
    assert.equal(panel.hidden, false);
    await act(async () => disclosure.click());
    assert.equal(disclosure.getAttribute("aria-expanded"), "false");
    await act(async () => button.click());
    assert.equal(writes.at(-1), value);
    assert.equal(button.getAttribute("aria-label"), "Copied");
    assert.match(container.textContent!, /Copied to clipboard/);
    fail = true;
    await act(async () => button.click());
    assert.notEqual(button.getAttribute("aria-label"), "Copied");
    assert.match(container.textContent!, /Couldn’t copy/);
    fail = false;
    await act(async () => button.click());
    assert.doesNotMatch(container.textContent!, /Couldn’t copy/);
  }
  assert.equal(submits, 0);
});
