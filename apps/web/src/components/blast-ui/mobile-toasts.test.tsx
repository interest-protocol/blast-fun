import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom, waitFor } from "../../../test/fixtures/social/test-dom.ts";
const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { toast: sonner } = await import("sonner");
import type { ToastT } from "sonner";
const { MobileToastTarget, ToastProvider, useToast } = await import("./Toasts.tsx");

test("a mobile result stays in its own row, follows resize/remount, and retains recovery", async (t) => {
  let mobile = true;
  const listeners = new Set<() => void>();
  t.mock.method(window, "matchMedia", () => ({ matches: mobile, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let attempts = 0;
  function Demo({ slot = true }: { slot?: boolean }) {
    const toast = useToast();
    return <>
      <button onClick={() => toast("Claim failed", { id: "mobile-result", mobileTargetId: "first-row", tone: "error", sub: "Nothing was claimed.", action: { label: "Retry", onClick: () => { attempts++; } } })}>Claim</button>
      {slot ? <MobileToastTarget id="first-row" /> : null}
      <MobileToastTarget id="second-row" />
    </>;
  }
  const render = async (slot = true) => act(async () => root.render(<ToastProvider><Demo slot={slot} /></ToastProvider>));
  const tick = async () => act(async () => { await new Promise(resolve => window.setTimeout(resolve, 30)); });
  t.after(async () => { await act(async () => { sonner.dismiss(); }); await tick(); await act(async () => root.unmount()); container.remove(); });
  await render();
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  trigger.focus();
  await act(async () => trigger.click());
  await tick();
  assert.match(document.getElementById("first-row")!.textContent!, /Claim failedNothing was claimed.Retry/);
  assert.equal(document.getElementById("second-row")!.textContent, "");
  assert.equal(container.querySelectorAll('[role="status"]').length, 1);
  assert.equal((sonner.getToasts().find(toast => toast.id === "mobile-result") as ToastT).position, "top-center");

  await act(async () => { mobile = false; listeners.forEach(listener => listener()); });
  await tick();
  assert.equal(document.getElementById("first-row")!.textContent, "");
  assert.equal(container.querySelectorAll('[data-inline-toast-placeholder]').length, 0);
  assert.equal((sonner.getToasts().find(toast => toast.id === "mobile-result") as ToastT).position, "bottom-right");

  await act(async () => { mobile = true; listeners.forEach(listener => listener()); });
  await tick();
  assert.match(document.getElementById("first-row")!.textContent!, /Claim failed/);
  await render(false);
  await tick();
  assert.equal(container.querySelectorAll('[data-inline-toast-placeholder]').length, 0, "unmounted rows return feedback to the floating host");
  await render();
  await tick();
  const retry = [...document.getElementById("first-row")!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry")!;
  await act(async () => retry.click());
  await waitFor(() => document.getElementById("first-row")?.textContent === "", "the inline toast to clear after Retry");
  assert.equal(attempts, 1);
  assert.equal(document.activeElement, trigger);
  assert.equal(document.getElementById("first-row")!.textContent, "");
});
