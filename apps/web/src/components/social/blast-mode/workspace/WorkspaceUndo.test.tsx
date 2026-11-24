import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WorkspaceUndo } = await import("./WorkspaceUndo.tsx");

for (const keyboard of [true, false]) test(`Undo with ${keyboard ? "keyboard" : "mouse or touch"} focus ${keyboard ? "waits" : "still expires"}`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_791_000_000_000 });
  const matches = dom.window.Element.prototype.matches;
  t.after(() => { dom.window.Element.prototype.matches = matches; });
  dom.window.Element.prototype.matches = function (this: Element, selector: string) {
    return selector === ":focus-visible" ? keyboard : matches.call(this, selector);
  } as typeof matches;
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  let dismissed = 0;
  try {
    await act(async () => root.render(<WorkspaceUndo className="" label="Settings not saved" undo={() => {}} dismiss={() => { dismissed += 1; }} />));
    await act(async () => container.querySelector("button")!.focus());
    await act(async () => t.mock.timers.tick(6_000));
    assert.equal(dismissed, keyboard ? 0 : 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
