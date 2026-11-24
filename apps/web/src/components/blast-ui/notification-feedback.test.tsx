import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, recordAnimations } from "../../../test/fixtures/social/test-dom.ts";
const { document, window } = installTestDom();
const { act, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useNotificationFeedback } = await import("./notification-feedback.ts");

test("bell feedback coalesces, stays decorative, stops on hide/remount, and respects reduced motion", async (t) => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const emit = () => { for (const listener of listeners) listener(); };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const recorder = recordAnimations();
  let reduced = false;
  t.mock.method(window, "matchMedia", () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  function Bell({ empty = false }: { empty?: boolean }) {
    const halo = useRef<HTMLSpanElement>(null);
    const badge = useRef<HTMLElement>(null);
    useNotificationFeedback(subscribe, halo, badge);
    return <button><svg /><span aria-hidden="true" ref={halo} style={{ "--ease": "cubic-bezier(.16,1,.3,1)" } as import("react").CSSProperties} /><em aria-hidden="true" data-empty={empty ? "" : undefined} ref={badge}>2</em></button>;
  }
  const render = async (empty = false) => { await act(async () => root.render(<Bell empty={empty} />)); };
  const tick = async () => { await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 30)); }); };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await render();
  assert.equal(recorder.all.length, 0);
  emit(); emit();
  await tick();
  assert.equal(recorder.all.length, 2);
  assert.equal(recorder.all[0]!.timing.duration, 240);
  assert.equal(recorder.all[0]!.target.tagName, "SPAN");
  assert.ok(recorder.all.every((animation) => animation.target.tagName !== "SVG"));
  document.dispatchEvent(new window.Event("visibilitychange"));
  assert.ok(recorder.all.every((animation) => animation.playState === "idle"));
  await render(true);
  assert.equal(recorder.all.length, 2, "clearing alone is not arrival feedback");
  reduced = true;
  await render();
  emit();
  await tick();
  assert.equal(recorder.all.length, 2);
});
