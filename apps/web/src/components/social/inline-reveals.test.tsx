import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";

import { installTestDom, testEvent } from "../../../test/fixtures/social/test-dom.ts";
import { createStore, useCreateState } from "./create/create-store";

const { document } = installTestDom();
const { createRoot } = await import("react-dom/client");
// Base UI selects its browser layout effects when these components are imported.
const { CreateForm } = await import("./create/CreateForm");
const { WhyComposer } = await import("./post/WhyComposer");
const noop = () => undefined;

test("Add why reveals only on pointer opening and preserves editor and return focus", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(() => root.render(<WhyComposer entryId="a:1:0:0:0" kind="presale_commit" onPosted={noop} />));
    for (const detail of [1, 0]) {
      await act(() => host.querySelector("button")!.dispatchEvent(testEvent("click", { detail })));
      const box = host.querySelector("[data-why-box]")!;
      assert.equal(box.hasAttribute("data-pointer-reveal"), detail > 0);
      assert.equal(document.activeElement, host.querySelector("textarea"));
      await act(() => host.querySelector("textarea")!.dispatchEvent(testEvent("keydown", { key: "Escape" })));
      assert.equal(host.querySelector("textarea"), null);
      assert.equal(document.activeElement, host.querySelector("button"));
    }
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});

function Draft() {
  const state = useCreateState();
  return <CreateForm state={state} issues={[]} onLogo={noop} onList={noop} />;
}

test("optional draft fields reveal on pointer clicks, while keyboard actions and initial fields stay immediate", async () => {
  // Lift limits lives on the Raise step since Create follows the boards' four steps.
  createStore.reset({ phase: "ready", step: "raise" });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(() => root.render(<Draft />));
    const form = host.querySelector("fieldset")!;
    assert.equal(form.hasAttribute("data-pointer-reveal"), false);
    const lift = host.querySelector('[aria-label="Lift limits near the end"]')!;
    for (const detail of [1, 0]) {
      await act(() => lift.dispatchEvent(testEvent("click", { detail })));
      const panel = document.getElementById(lift.getAttribute("aria-controls")!)!;
      assert.ok(panel.querySelector(".cr-sub"));
      assert.equal(form.hasAttribute("data-pointer-reveal"), detail > 0);
      await act(() => lift.dispatchEvent(testEvent("click", { detail })));
      assert.equal(panel.getAttribute("aria-hidden"), "true");
      assert.equal(panel.hasAttribute("inert"), true);
      // Collapse disables closed content immediately; let its deferred exit frames settle.
      for (let frame = 0; frame < 10 && host.contains(panel); frame += 1) {
        await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      }
      assert.equal(host.contains(panel), false);
    }
    await act(() => lift.dispatchEvent(testEvent("click", { detail: 1 })));
    assert.equal(form.hasAttribute("data-pointer-reveal"), true);
    await act(() => lift.dispatchEvent(testEvent("keydown", { key: "Tab" })));
    assert.equal(form.hasAttribute("data-pointer-reveal"), false);
    assert.ok(host.querySelector(".cr-sub"));
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
