import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const { act, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useFeedbackReveal } = await import("./feedback-motion");

function Region({ value }: { value: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFeedbackReveal(value, ref);
  return <div ref={ref}><input aria-label="Amount" defaultValue="42" /></div>;
}

test("content reveals once per change, preserves inputs, and skips keyboard and reduced motion", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let animations = 0;
  let cancelled = 0;
  t.mock.method(window.HTMLElement.prototype, "animate", () => { animations++; return { cancel() { cancelled++; } }; });
  t.after(async () => { await act(async () => root.unmount()); container.remove(); delete document.documentElement.dataset.blastInput; });
  await act(async () => root.render(<Region value="loading" />));
  const input = container.querySelector("input")!;
  input.focus();
  assert.equal(animations, 0);
  await act(async () => root.render(<Region value="ready" />));
  assert.equal(animations, 1);
  assert.equal(document.activeElement, input);
  assert.equal(input.value, "42");
  await act(async () => root.render(<Region value="ready" />));
  assert.equal(animations, 1);
  document.documentElement.dataset.blastInput = "keyboard";
  await act(async () => root.render(<Region value="sell" />));
  assert.equal(animations, 1);
  assert.equal(cancelled, 1);
  delete document.documentElement.dataset.blastInput;
  t.mock.method(window, "matchMedia", () => ({ matches: true }));
  await act(async () => root.render(<Region value="buy" />));
  assert.equal(animations, 1);
});
