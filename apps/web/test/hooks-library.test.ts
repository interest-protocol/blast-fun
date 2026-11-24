import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, StrictMode, useEffect } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { JSDOM } from "jsdom";
import { useReducedMotion } from "#web/components/blast-ui/use-shell-prefs.ts";
import { scheduleDelay } from "#web/lib/schedule-delay.ts";

function browser(t: test.TestContext) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://blast.test" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    innerWidth: 1024,
    innerHeight: 768,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  for (const key of ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const) {
    Object.defineProperty(dom.window, key, { value: globalThis[key], configurable: true });
  }
  t.after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const container = dom.window.document.getElementById("root")!;
  return { dom, container, advance: (ms: number) => act(() => t.mock.timers.tick(ms)) };
}

test("scene fallback fires only after 10 seconds and cancels on unmount in StrictMode", async (t) => {
  const { container, advance } = browser(t);
  const ready: string[] = [];
  function Scene({ label }: { label: string }) {
    useEffect(() => scheduleDelay(() => ready.push(label), 10_000), [label]);
    return null;
  }
  const root = createRoot(container);
  t.after(() => act(() => root.unmount()));
  await act(() => root.render(createElement(StrictMode, null, createElement(Scene, { label: "current" }))));
  await advance(9999);
  assert.deepEqual(ready, []);
  await advance(1);
  assert.deepEqual(ready, ["current"]);
  await act(() => root.render(createElement(StrictMode, null, createElement(Scene, { key: "new", label: "cancelled" }))));
  await act(() => root.unmount());
  await advance(10_000);
  assert.deepEqual(ready, ["current"]);
});

test("reduced motion keeps server/initial hydration false then follows preferences and cleans up", async (t) => {
  function Preference() {
    const reduced = useReducedMotion();
    return createElement("output", null, String(reduced));
  }
  const html = renderToString(createElement(Preference));
  assert.equal(html, "<output>false</output>");
  const { dom, container } = browser(t);
  let matches = true;
  const listeners = new Set<(event: { matches: boolean }) => void>();
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({
    matches,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
  }) });
  container.innerHTML = html;
  const errors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot>;
  await act(() => {
    root = hydrateRoot(container, createElement(StrictMode, null, createElement(Preference)), {
      onRecoverableError: (error) => errors.push(error),
    });
  });
  t.after(() => act(() => root.unmount()));
  assert.equal(container.textContent, "true");
  assert.equal(listeners.size, 1);
  assert.deepEqual(errors, []);
  await act(() => {
    matches = false;
    for (const listener of listeners) listener({ matches });
  });
  assert.equal(container.textContent, "false");
  await act(() => root.unmount());
  assert.equal(listeners.size, 0);
});
