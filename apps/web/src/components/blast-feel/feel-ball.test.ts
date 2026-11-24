import assert from "node:assert/strict";
import test from "node:test";

import { FEEL_CHARGING_CLASS, FEEL_SOUND_BUTTON_CLASS, flyBall, shakeBall } from "./feel-ball.ts";
import { FEEL_BALL_SHAKE_EXIT_MS } from "./feel-hold.ts";
import { FeelScope, type FeelScopeHost } from "./feel-scope.ts";
import { motionAllowed } from "./feel-sound-pref.ts";

/**
 * OA-23 / FEEL-LAYER.md §4 and §6.2, the non-negotiable: under
 * `prefers-reduced-motion: reduce` the layer is **switched off, not shortened**.
 * The gate creates the ball and removes it in the same task; here no ball is
 * created at all, and the commit and its sound are untouched.
 *
 * Also the ball's own lifecycle: it belongs to a `FeelScope`, so a surface that
 * unmounts mid-flight takes it with it rather than leaving a pink dot on the
 * page.
 */

type Node = { className: string; attributes: Record<string, string>; style: Record<string, string>; removed: number; animated: unknown[] };

function fakeHost(): FeelScopeHost & { fireAll: () => void; pending: () => number } {
  let next = 1;
  const timeouts = new Map<number, () => void>();
  return {
    setTimeout(handler) {
      const id = next++;
      timeouts.set(id, handler);
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval() {
      return 0;
    },
    clearInterval() {
      /* unused */
    },
    requestAnimationFrame() {
      return 0;
    },
    cancelAnimationFrame() {
      /* unused */
    },
    fireAll() {
      for (const [id, handler] of [...timeouts]) {
        timeouts.delete(id);
        handler();
      }
    },
    pending: () => timeouts.size,
  };
}

function fakeDocument(options: Readonly<{ canAnimate?: boolean }> = {}) {
  const created: Node[] = [];
  const appended: Node[] = [];
  const document = {
    createElement() {
      const node: Node = { className: "", attributes: {}, style: {}, removed: 0, animated: [] };
      const element = {
        get className() {
          return node.className;
        },
        set className(value: string) {
          node.className = value;
        },
        setAttribute(name: string, value: string) {
          node.attributes[name] = value;
        },
        getAttribute: (name: string) => node.attributes[name] ?? null,
        style: {
          set left(value: string) {
            node.style.left = value;
          },
          set top(value: string) {
            node.style.top = value;
          },
          setProperty(name: string, value: string) {
            node.style[name] = value;
          },
        },
        remove() {
          node.removed += 1;
        },
        animate: options.canAnimate === false ? undefined : (keyframes: unknown, animationOptions: unknown) => {
          node.animated.push({ keyframes, options: animationOptions });
          return { onfinish: null as (() => void) | null, oncancel: null as (() => void) | null };
        },
      };
      created.push(node);
      Object.defineProperty(node, "element", { value: element });
      return element;
    },
    body: {
      appendChild(element: { getAttribute(name: string): string | null }) {
        const found = created.find((candidate) => candidate.attributes["aria-hidden"] === element.getAttribute("aria-hidden"));
        if (found) appended.push(found);
      },
    },
  };
  return { document, created, appended };
}

const BUTTON = { left: 100, top: 200, width: 80, height: 40 } as const;

test("with no landing point there is no ball at all: the reduced-motion path", async () => {
  // `use-feel-hold` passes `null` whenever `motionAllowed()` is false, so this
  // is exactly what a reader who asked for reduced motion gets.
  const harness = fakeHost();
  const scope = new FeelScope(harness);
  const fake = fakeDocument();
  await flyBall({ document: fake.document as unknown as Document, scope }, BUTTON, null, 2);
  assert.equal(fake.created.length, 0, "nothing is created, not created-and-removed as the gate does");
  assert.deepEqual(scope.active(), { timers: 0, frames: 0, listeners: 0, nodes: 0 });
  scope.stop();
});

test("with a landing point the ball is a hidden, scope-owned node that flies and leaves", async () => {
  const harness = fakeHost();
  const scope = new FeelScope(harness);
  const fake = fakeDocument();
  const flight = flyBall({ document: fake.document as unknown as Document, scope }, BUTTON, { x: 500, y: 300 }, 2);
  const ball = fake.created[0]!;
  assert.equal(fake.created.length, 1);
  assert.equal(ball.attributes["aria-hidden"], "true", "assistive tech never hears about it");
  assert.equal(ball.className, "ball", "the module's class, which carries pointer-events: none");
  assert.equal(ball.style.left, "140px", "the button's centre");
  assert.equal(ball.style.top, "220px");
  assert.equal(ball.style["--feel-ball-scale"], "1.28", "a step bigger for each amount");
  assert.equal(ball.animated.length, 1, "one animation, not a per-frame loop");
  assert.equal(scope.active().nodes, 1, "the scope owns it while it is in flight");

  // The animation finishing is what resolves the landing.
  harness.fireAll();
  await flight;
  assert.equal(ball.removed, 1);
  assert.deepEqual(scope.active(), { timers: 0, frames: 0, listeners: 0, nodes: 0 });
  scope.stop();
});

test("a surface that unmounts mid-flight takes the ball with it", async () => {
  const harness = fakeHost();
  const scope = new FeelScope(harness);
  const fake = fakeDocument();
  void flyBall({ document: fake.document as unknown as Document, scope }, BUTTON, { x: 500, y: 300 }, 0);
  const ball = fake.created[0]!;
  assert.equal(ball.removed, 0);
  scope.stop();
  assert.equal(ball.removed, 1, "no pink dot left on the page");
  assert.equal(harness.pending(), 0, "and no timer waiting to touch it");
});

test("a browser without Element.animate gets the commit and no ball", async () => {
  const harness = fakeHost();
  const scope = new FeelScope(harness);
  const fake = fakeDocument({ canAnimate: false });
  await flyBall({ document: fake.document as unknown as Document, scope }, BUTTON, { x: 500, y: 300 }, 1);
  assert.equal(fake.created[0]!.removed, 1);
  assert.deepEqual(scope.active(), { timers: 0, frames: 0, listeners: 0, nodes: 0 });
  scope.stop();
});

test("a refused quote shakes the ball and removes it on the scope's own timer", async () => {
  const harness = fakeHost();
  const scope = new FeelScope(harness);
  const fake = fakeDocument();
  const shaking = shakeBall({ document: fake.document as unknown as Document, scope }, BUTTON, 1);
  const ball = fake.created[0]!;
  assert.equal(ball.animated.length, 1);
  assert.equal(scope.active().timers, 1, `the exit is one ${FEEL_BALL_SHAKE_EXIT_MS} ms timer`);
  harness.fireAll();
  await shaking;
  assert.equal(ball.removed, 1);
  assert.deepEqual(scope.active(), { timers: 0, frames: 0, listeners: 0, nodes: 0 });
  scope.stop();
});

test("motionAllowed is false on the server and under reduced motion, true otherwise", () => {
  const global = globalThis as { window?: unknown };
  const had = Object.prototype.hasOwnProperty.call(global, "window");
  const before = global.window;
  try {
    delete global.window;
    assert.equal(motionAllowed(), false, "no window: the server, where the layer animates nothing");

    global.window = { matchMedia: (query: string) => ({ matches: query.includes("reduce") }) };
    assert.equal(motionAllowed(), false, "reduced motion switches it off");

    global.window = { matchMedia: () => ({ matches: false }) };
    assert.equal(motionAllowed(), true);

    global.window = {};
    assert.equal(motionAllowed(), false, "a browser without matchMedia is treated as reduced");
  } finally {
    if (had) global.window = before;
    else delete global.window;
  }
});

test("the classes the layer hands out are the module's own, not global names", () => {
  assert.equal(FEEL_CHARGING_CLASS, "charging");
  assert.equal(FEEL_SOUND_BUTTON_CLASS, "soundButton");
});

test("R3-13-AC-8: the ball joins the app's root (the shell's tokens, its overlay layer), not the body, and is aria-hidden", async () => {
  const harness = fakeHost();
  const scope = new FeelScope(harness);
  const fake = fakeDocument();
  const joined: unknown[] = [];
  const root = { appendChild: (element: unknown) => joined.push(element) };
  void flyBall({ document: fake.document as unknown as Document, scope, parent: root as unknown as Element }, BUTTON, { x: 400, y: 120 }, 1);
  assert.equal(joined.length, 1, "into [data-blast-ui]");
  assert.deepEqual(fake.appended, [], "never document.body when the root is there");
  assert.equal(fake.created[0]!.attributes["aria-hidden"], "true");
  // A route change takes a ball still in flight with it, and the scope keeps working.
  scope.releaseNodes();
  assert.equal(fake.created[0]!.removed, 1);
  assert.equal(scope.stopped, false);
  harness.fireAll();
  scope.stop();
});

test("R3-13-AC-8: the ball sits below any open sheet (80) and the toasts (90), above Blast mode (60) and its popovers (70)", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("./feel.module.css", import.meta.url), "utf8");
  const ball = /\.ball \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(ball, /z-index: 75;/);
  assert.match(ball, /pointer-events: none;/);
  assert.match(ball, /position: fixed;/);
});

type FakeEl = {
  rect: { left: number; top: number; width: number; height: number; bottom: number };
  fills: { parentElement: FakeEl | null; animated: unknown[] }[];
};

function barRoot(bars: readonly FakeEl[]) {
  return {
    querySelectorAll: (selector: string) => {
      assert.equal(selector, '[data-bar="0xtide"]');
      return bars.flatMap((bar) => bar.fills);
    },
  };
}

function track(top: number, width = 200): FakeEl {
  const bar: FakeEl = { rect: { left: 10, top, width, height: 6, bottom: top + 6 }, fills: [] };
  bar.fills.push({ parentElement: bar, animated: [] });
  return bar;
}

test("R3-13: the ball lands in the sale's bar near the button, else any visible one on the page, else nowhere", async () => {
  const { feelBarFor } = await import("./feel-ball.ts");
  const visible = (el: FakeEl) => ({ ...el, getBoundingClientRect: () => el.rect });
  const near = track(300);
  const far = track(600);
  const offscreen = track(5_000);
  const wrap = (bar: FakeEl) => {
    const element = visible(bar);
    for (const fill of bar.fills) fill.parentElement = element as unknown as FakeEl;
    return element;
  };
  wrap(near);
  wrap(far);
  wrap(offscreen);
  const doc = { defaultView: { innerHeight: 900 }, ...barRoot([offscreen, far, near]) };
  const button = (scope: unknown) => ({ ownerDocument: doc, closest: () => scope });
  // The card's own bar first.
  assert.equal((feelBarFor(button(barRoot([near])) as unknown as Element, "0xtide") as unknown as { rect: unknown }).rect, near.rect);
  // No bar in the post: the first visible one on the page (the off-screen one is skipped).
  assert.equal((feelBarFor(button(null) as unknown as Element, "0xtide") as unknown as { rect: unknown }).rect, far.rect);
  // Nothing on screen: no flight.
  const empty = { defaultView: { innerHeight: 900 }, ...barRoot([offscreen]) };
  assert.equal(feelBarFor({ ownerDocument: empty, closest: () => null } as unknown as Element, "0xtide"), null);
});

test("R3-13: the bar flashes its fills as the ball lands, the gate's bxFlash (.9 s, brightest at 30 %)", async () => {
  const { flashBar, FEEL_BAR_FLASH_MS } = await import("./feel-ball.ts");
  const animated: { keyframes: unknown; options: KeyframeAnimationOptions }[] = [];
  const fill = { animate: (keyframes: unknown, options: KeyframeAnimationOptions) => animated.push({ keyframes, options }) };
  flashBar({ querySelectorAll: () => [fill] } as unknown as Element);
  assert.equal(animated.length, 1);
  assert.equal(FEEL_BAR_FLASH_MS, 900);
  assert.deepEqual(animated[0]!.keyframes, [{ filter: "none" }, { filter: "brightness(1.45) saturate(1.3)", offset: 0.3 }, { filter: "none" }]);
  assert.equal(animated[0]!.options.duration, 900);
});
