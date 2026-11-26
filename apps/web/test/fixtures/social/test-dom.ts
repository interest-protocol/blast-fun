/** Tests use jsdom's DOM, selectors and event dispatch; layout and Web Animations stay deterministic. */
import { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM, type DOMWindow } from "jsdom";

export type TestElement = HTMLElement;
export type TestNode = Node;
export type TestEvent = Event;
export let TestElement: typeof HTMLElement;
export let TestNode: typeof Node;
let browser: DOMWindow;

/**
 * Wait for a condition, never a fixed time: check it, flush React inside `act`,
 * and check again until it returns a truthy value (which is returned) without
 * throwing. A pass returns at once, so the 30 s cap only bounds a real failure,
 * which reports the last error and the last DOM.
 */
export async function waitFor<T>(condition: () => T, description: string, timeoutMs = 30_000): Promise<Exclude<T, false | null | undefined>> {
  const { act } = await import("react");
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const check = attempt(condition);
    if (check.value) return check.value as Exclude<T, false | null | undefined>;
    if (performance.now() >= deadline) throw timedOut(description, timeoutMs, check.error);
    await act(async () => delay(10));
  }
}

function attempt<T>(condition: () => T): { value?: T; error?: unknown } {
  try {
    return { value: condition() };
  } catch (error) {
    return { error };
  }
}

function timedOut(description: string, timeoutMs: number, last: unknown): Error {
  const dom = globalThis.document?.body?.outerHTML ?? "(no DOM)";
  const reason = last === undefined ? "" : `\nLast error: ${last instanceof Error ? last.message : String(last)}`;
  const tail = dom.length > 8_000 ? `…${dom.slice(-8_000)}` : dom;
  return new Error(`Timed out after ${timeoutMs} ms waiting for ${description}${reason}\nLast DOM:\n${tail}`, { cause: last });
}

/** Keyboard, pointer and focus events retain real DOM propagation and cancellation. */
export function testEvent(type: string, init: EventInit & Record<string, unknown> = {}): Event {
  const options = { bubbles: true, cancelable: true, ...init };
  const EventClass = type.startsWith("key") ? browser.KeyboardEvent
    : type.startsWith("pointer") ? browser.PointerEvent
    : type.startsWith("mouse") || type === "click" ? browser.MouseEvent
    : type.startsWith("focus") ? browser.FocusEvent
    : browser.Event;
  const event = new EventClass(type, options);
  for (const [name, value] of Object.entries(init)) {
    if (name in event && (event as unknown as Record<string, unknown>)[name] === value) continue;
    Object.defineProperty(event, name, { value, configurable: true, writable: true });
  }
  return event;
}

/** A browser edit changes the native value before React sees its input event. */
export function setInputValue(element: HTMLElement, value: string): void {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new TypeError("Expected a text field");
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
}

/** One `element.animate()` call, as `recordAnimations` keeps it: it runs until the test finishes or something cancels it. */
export class TestAnimation {
  readonly target: TestElement;
  readonly keyframes: readonly Record<string, unknown>[];
  readonly fill: string;
  /** The options it was started with (`duration`, `easing`, `fill`…). */
  readonly timing: Readonly<Record<string, unknown>>;
  playState: "running" | "finished" | "idle" = "running";
  onfinish: ((event: TestEvent) => void) | null = null;
  oncancel: ((event: TestEvent) => void) | null = null;
  readonly finished: Promise<TestAnimation>;
  private settle: (animation: TestAnimation) => void = () => undefined;

  constructor(target: TestElement, keyframes: readonly Record<string, unknown>[], fill: string, timing: Readonly<Record<string, unknown>> = {}) {
    this.target = target;
    this.keyframes = keyframes;
    this.fill = fill;
    this.timing = timing;
    this.finished = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /** Its `KeyframeEffect`: the element it animates and the timing it was started with (Base UI and Home read both). */
  get effect(): Readonly<{ target: TestElement; getTiming(): Readonly<Record<string, unknown>>; getComputedTiming(): Readonly<{ endTime: number }> }> {
    const timing = this.timing;
    return {
      target: this.target,
      getTiming: () => timing,
      getComputedTiming: () => ({
        endTime: timing.iterations === Infinity
          ? Infinity
          : Number(timing.delay ?? 0) + Number(timing.duration ?? 0) * Number(timing.iterations ?? 1) + Number(timing.endDelay ?? 0),
      }),
    };
  }
  /** It still applies to its element: running, or held at its end by `fill`. */
  get inEffect(): boolean {
    return this.playState === "running" || (this.playState === "finished" && (this.fill === "forwards" || this.fill === "both"));
  }
  finish(): void {
    if (this.playState !== "running") return;
    this.playState = "finished";
    this.settle(this);
    this.onfinish?.(testEvent("finish", { bubbles: false }));
  }
  cancel(): void {
    if (this.playState === "idle") return;
    this.playState = "idle";
    this.oncancel?.(testEvent("cancel", { bubbles: false }));
  }
  play(): void {}
  pause(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

let recorded: TestAnimation[] | null = null;

/**
 * From here on `element.animate()` keeps each animation instead of answering
 * with a stub that never ends, so a test can run motion to its end and see
 * what it leaves behind: `finishAll()` ends every running animation, oldest
 * first (each `onfinish` fires, and so do the ones those start); an
 * element's `getAnimations()` lists the ones still in effect, as a
 * browser's does; `heldOpacity()` is the opacity they leave on an element
 * (the newest in effect wins, a running one counted at its end).
 */
export function recordAnimations() {
  const kept: TestAnimation[] = [];
  recorded = kept;
  return {
    all: kept,
    finishAll(): void {
      for (let round = 0; round < 10; round += 1) {
        const running = kept.filter((animation) => animation.playState === "running");
        if (running.length === 0) return;
        for (const animation of running) animation.finish();
      }
    },
    heldOpacity(element: TestElement): number {
      const last = kept.filter((animation) => animation.target === element && animation.inEffect && animation.keyframes.at(-1)?.opacity !== undefined).at(-1);
      return last === undefined ? 1 : Number(last.keyframes.at(-1)!.opacity);
    },
  };
}

type TrackedTarget = { listeners: { count(): number } };
export type TestDom = Readonly<{
  window: DOMWindow & TrackedTarget & { reducedMotion: boolean };
  document: Document & TrackedTarget;
}>;

/** Keep listener leak assertions without owning event dispatch. */
function trackListeners(target: EventTarget): void {
  const listeners: { type: string; listener: EventListenerOrEventListenerObject; run: EventListener; capture: boolean }[] = [];
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  const captureOf = (options?: boolean | AddEventListenerOptions) => typeof options === "boolean" ? options : options?.capture === true;
  target.addEventListener = (type, listener, options) => {
    if (listener === null || (typeof options === "object" && options.signal?.aborted)) return;
    const capture = captureOf(options);
    if (listeners.some((entry) => entry.type === type && entry.listener === listener && entry.capture === capture)) return;
    const run: EventListener = (event) => {
      if (typeof options === "object" && options.once) target.removeEventListener(type, listener, options);
      if (typeof listener === "function") listener.call(target, event);
      else listener.handleEvent(event);
    };
    listeners.push({ type, listener, run, capture });
    if (typeof options === "object") options.signal?.addEventListener("abort", () => target.removeEventListener(type, listener, options), { once: true });
    add(type, run, options);
  };
  target.removeEventListener = (type, listener, options) => {
    const at = listeners.findIndex((entry) => entry.type === type && entry.listener === listener && entry.capture === captureOf(options));
    if (at < 0) return;
    const [entry] = listeners.splice(at, 1);
    remove(type, entry!.run, options);
  };
  Object.defineProperty(target, "listeners", { value: { count: () => listeners.length } });
}

/** Install before importing react-dom/client; Node runs each test file in its own process. */
/** jsdom has no canvas; the coin chart (KLineCharts) draws into this no-op 2D context. */
export function installNoopCanvas(dom: Pick<TestDom, "window">): void {
  const context2d: object = new Proxy({}, {
    get: (_, key) => key === "measureText" ? () => ({ width: 8 }) : key === "canvas" ? undefined : key === "createLinearGradient" ? () => ({ addColorStop() {} }) : () => context2d,
    set: () => true,
  });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => context2d) as never;
}

export function installTestDom(): TestDom {
  const { window } = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://127.0.0.1/",
    pretendToBeVisual: true,
  });
  after(() => window.close());
  browser = window;
  TestElement = window.HTMLElement;
  TestNode = window.Node;
  Object.defineProperty(window, "reducedMotion", { value: false, configurable: true, writable: true });
  window.matchMedia = (query: string) => ({
    matches: /prefers-reduced-motion:\s*reduce/.test(query) && Boolean(window.reducedMotion),
    media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true,
  });
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  // shortcut: jsdom has no layout or Web Animations, use a browser for geometry and rendered motion.
  Object.assign(window.HTMLElement.prototype, { scrollTo() {}, scrollBy() {}, scrollIntoView() {} });
  Object.assign(window.Element.prototype, {
    animate(this: TestElement, keyframes?: unknown, options?: unknown) {
      if (recorded === null) return { cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null, finished: Promise.resolve(), addEventListener() {} };
      const timing = typeof options === "object" && options !== null ? options as Record<string, unknown> : typeof options === "number" ? { duration: options } : {};
      const animation = new TestAnimation(this, Array.isArray(keyframes) ? keyframes : [], String(timing.fill ?? "none"), timing);
      recorded.push(animation);
      return animation;
    },
    getAnimations(this: TestElement) { return recorded?.filter((animation) => animation.target === this && animation.inEffect) ?? []; },
  });
  // jsdom does not implement inert focus suppression yet.
  const focus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function(options?: FocusOptions) {
    if (this.closest("[inert]") === null) focus.call(this, options);
  };
  trackListeners(window);
  trackListeners(window.document);
  const globals: Record<string, unknown> = {
    window, document: window.document, self: window, navigator: window.navigator,
    location: window.location, history: window.history, localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    matchMedia: window.matchMedia.bind(window), getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: Observer, IntersectionObserver: Observer, CSS: { escape: (value: string) => value.replace(/["\\]/g, "\\$&"), supports: () => false },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of ["Node", "NodeList", "NodeFilter", "Element", "HTMLElement", "SVGElement", "Text", "Document", "HTMLIFrameElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLDialogElement", "Event", "CustomEvent", "EventTarget", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent", "ShadowRoot", "MutationObserver", "AbortController", "AbortSignal"]) globals[name] = window[name];
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    if (!(name in window)) Object.defineProperty(window, name, { value, configurable: true, writable: true });
  }
  // Fetch keeps Node's implementation; jsdom supplies the browser-only APIs above.
  for (const name of ["fetch", "Response", "Request", "Headers"]) Object.defineProperty(window, name, { value: (globalThis as Record<string, unknown>)[name], configurable: true, writable: true });
  // No live socket unless a test installs a fake one (`installLiveSocket`): Node's WebSocket would reach the network.
  if (!Reflect.deleteProperty(globalThis, "WebSocket")) throw new Error("the global WebSocket could not be removed");
  return { window, document: window.document } as TestDom;
}
