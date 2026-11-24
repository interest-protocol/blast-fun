import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { applyTheme, setShellPref, THEME_FADE_MS } from "./use-shell-prefs";

/**
 * The theme change (tokens.md §1; OA-31, the gate's version 5): a circular
 * reveal from the pressed control, or — with reduced motion — a 200 ms
 * cross-fade of the new theme over the old, never a sudden flash. The View
 * Transition API, the document and the media queries are stand-ins.
 */

type Animation = Readonly<{ keyframes: Record<string, unknown>; options: KeyframeAnimationOptions }>;

const globals = globalThis as unknown as Record<string, unknown>;
const saved = { document: globals.document, window: globals.window, innerWidth: globals.innerWidth, innerHeight: globals.innerHeight };

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
});

function page({ reduced, viewTransitions = true }: Readonly<{ reduced: boolean; viewTransitions?: boolean }>) {
  const classes = new Set<string>();
  const animations: Animation[] = [];
  const stored = new Map<string, string>();
  const log: string[] = [];
  const transitions: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  globals.document = {
    documentElement: {
      classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
      animate: (keyframes: Record<string, unknown>, options: KeyframeAnimationOptions) => {
        animations.push({ keyframes, options });
        return {};
      },
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    startViewTransition: viewTransitions
      ? (update: () => void) => {
          log.push(`transition (theming: ${classes.has("blast-theming")})`);
          const finished = Promise.withResolvers<void>();
          transitions.push(finished);
          update();
          return { ready: Promise.resolve(), finished: finished.promise, updateCallbackDone: Promise.resolve() };
        }
      : undefined,
  };
  globals.window = {
    matchMedia: (query: string) => ({ matches: query.includes("prefers-reduced-motion") ? reduced : false }),
    localStorage: { setItem: (key: string, value: string) => stored.set(key, value), getItem: (key: string) => stored.get(key) ?? null },
  };
  globals.innerWidth = 1000;
  globals.innerHeight = 800;
  const origin = { getBoundingClientRect: () => ({ left: 100, top: 200, width: 40, height: 40 }) } as unknown as Element;
  return { classes, animations, stored, log, origin, finish: (index = 0) => transitions[index]?.resolve() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("OA-31: with reduced motion a theme change cross-fades the new theme in over 200 ms, through a View Transition", async () => {
  const view = page({ reduced: true });
  applyTheme("dark", view.origin);
  assert.deepEqual(view.log, ["transition (theming: true)"], "the default cross-fade is off before the snapshot (blast-ui.css `html.blast-theming`)");
  assert.equal(view.stored.get("blast.theme"), JSON.stringify("dark"));
  await settle();
  assert.deepEqual(view.animations, [
    { keyframes: { opacity: [0, 1] }, options: { duration: THEME_FADE_MS, easing: "cubic-bezier(.23,1,.32,1)", pseudoElement: "::view-transition-new(root)" } },
  ]);
  assert.equal(THEME_FADE_MS, 200);
  assert.ok(view.classes.has("blast-theming"), "held while the fade runs");
  view.finish();
  await settle();
  assert.ok(!view.classes.has("blast-theming"), "cleared once the transition finishes");
});

test("without reduced motion the new theme still grows from the pressed control, over 300 ms", async () => {
  const view = page({ reduced: false });
  applyTheme("light", view.origin);
  await settle();
  assert.equal(view.animations.length, 1);
  const [reveal] = view.animations;
  assert.deepEqual(reveal!.options, { duration: 300, easing: "cubic-bezier(.77,0,.175,1)", pseudoElement: "::view-transition-new(root)" });
  // Centred on the control (120, 220), reaching the viewport's farthest corner (1000, 800).
  assert.deepEqual(reveal!.keyframes, { clipPath: ["circle(0px at 120px 220px)", `circle(${Math.hypot(880, 580)}px at 120px 220px)`] });
  view.finish();
  await settle();
  assert.ok(!view.classes.has("blast-theming"));
});

test("finishing an earlier theme transition leaves the latest theme animation in control", async () => {
  const view = page({ reduced: false });
  applyTheme("dark", view.origin);
  await settle();
  applyTheme("light", view.origin);
  view.finish(0);
  await settle();
  assert.ok(view.classes.has("blast-theming"));
  assert.equal(view.stored.get("blast.theme"), JSON.stringify("light"));
  view.finish(1);
  await settle();
  assert.ok(!view.classes.has("blast-theming"));
});

test("without View Transitions, or without a control to start from, the theme swaps at once", async () => {
  for (const [viewTransitions, withOrigin] of [
    [false, true],
    [true, false],
  ] as const) {
    const view = page({ reduced: true, viewTransitions });
    applyTheme("dark", withOrigin ? view.origin : null);
    await settle();
    assert.deepEqual(view.log, []);
    assert.deepEqual(view.animations, []);
    assert.equal(view.classes.size, 0);
    assert.equal(view.stored.get("blast.theme"), JSON.stringify("dark"));
  }
});

test("without view transitions, sidebar toggles enable CSS motion for either column and keep it enabled through a reversal", (context) => {
  const view = page({ reduced: false, viewTransitions: false });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const attributes = new Map<string, string>();
  const root = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  };
  (globals.document as { querySelector: () => unknown }).querySelector = () => root;
  setShellPref("railMini", true);
  assert.equal(attributes.get("data-rail"), "mini");
  assert.ok(attributes.has("data-shell-moving"));
  assert.equal(view.stored.get("blast.railMini"), "true");
  context.mock.timers.tick(150);
  setShellPref("railMini", false);
  assert.equal(attributes.get("data-rail"), "full");
  context.mock.timers.tick(150);
  assert.ok(attributes.has("data-shell-moving"), "the reversed transition keeps its full motion window");
  context.mock.timers.tick(150);
  assert.ok(!attributes.has("data-shell-moving"), "route changes snap again once the toggle settles");
  (globals.window as { matchMedia: () => unknown }).matchMedia = () => ({ matches: true });
  setShellPref("asideCollapsed", true);
  assert.equal(attributes.get("data-aside"), "collapsed", "reduced motion still applies the preference");
  assert.ok(!attributes.has("data-shell-moving"), "reduced motion needs no motion window");
  assert.deepEqual(view.animations, [], "column toggles do not add a second transform animation");
  context.mock.timers.tick(300);
  assert.ok(!attributes.has("data-shell-moving"));
});

test("with view transitions, a sidebar toggle morphs snapshots and never animates the grid; reduced motion keeps the transition for its crossfade", () => {
  for (const reduced of [false, true]) {
    const view = page({ reduced });
    const attributes = new Map<string, string>();
    const root = {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    };
    (globals.document as { querySelector: () => unknown }).querySelector = () => root;
    setShellPref("railMini", true);
    assert.equal(attributes.get("data-rail"), "mini");
    assert.deepEqual(view.log, ["transition (theming: false)"], "one snapshot transition");
    assert.ok(view.classes.has("blast-shell-changing"), "the shell's regions take their transition names");
    assert.ok(!attributes.has("data-shell-moving"), "the grid jumps once under the snapshots instead of reflowing every frame");
    view.finish();
  }
});
