import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { installTestDom, recordAnimations, testEvent, type TestAnimation, type TestElement } from "../../../test/fixtures/social/test-dom.ts";

/**
 * OA-28 M2b: a menu on base-ui's `Menu` (`BlastMenu`) with the gate's version
 * 5 motion (`blast-feel-preview-oa36.html`'s `openMenu`/`closeMenu`), in the
 * test DOM the way a page renders it (inside the Blast UI root, where base-ui
 * portals it). Every animation is kept (`recordAnimations`), so a test reads
 * the keyframes and timing each opening and closing starts, runs them to
 * their end, and sees what base-ui does once they finish.
 *
 * The device is set per test: `(max-width: 760px)` and
 * `(prefers-reduced-motion: reduce)` answer what the test says, and the
 * menu's computed `transform` is what the test says it is right now (the test
 * DOM has no layout), so a phone's exit can be seen to start where the menu
 * was.
 */

const { document, window } = installTestDom();
const motion = recordAnimations();

const media = { phone: false, reduce: false };
const query = (text: string) => {
  const matches = /max-width:\s*760px/.test(text) ? media.phone : /prefers-reduced-motion:\s*reduce/.test(text) ? media.reduce : false;
  return { matches, media: text, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
};
/** The live transform of each element, as a browser would compute it mid-animation. */
const live = new Map<unknown, string>();
const computed = (element: unknown) => ({ transform: live.get(element) ?? "none", getPropertyValue: () => "" });
Object.assign(window, { matchMedia: query, getComputedStyle: computed });
Object.assign(globalThis, { matchMedia: query, getComputedStyle: computed });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Menu } = await import("@base-ui/react/menu");
const { LibraryProviders } = await import("../ui-libraries/LibraryProviders");
const { BlastMenu, BlastMenuTrigger } = await import("./BlastMenu");

const PLACEMENT = { side: "bottom", align: "end", sideOffset: 6, avoid: "flip", originX: "calc(100% - 18px)" } as const;

/** A page with a menu (two rows, one that keeps the menu open, a disabled one) and a control outside it. */
function Page({ calls }: Readonly<{ calls: string[] }>) {
  const [count, setCount] = useState(0);
  return (
    <>
      <button data-outside="" onClick={() => calls.push("outside")} type="button">
        Elsewhere
      </button>
      <BlastMenu
        className="menu"
        id="probe-menu"
        label="Probe"
        placement={() => PLACEMENT}
        trigger={
          <BlastMenuTrigger aria-label="More" data-trigger="">
            More
          </BlastMenuTrigger>
        }
      >
        <Menu.Item className="mitem" nativeButton onClick={() => calls.push("copy")} render={<button type="button" />}>
          Copy link
        </Menu.Item>
        <Menu.Item className="mitem" closeOnClick={false} nativeButton onClick={() => setCount(count + 1)} render={<button type="button" />}>
          Appearance {count}
        </Menu.Item>
        <Menu.Item className="mitem" disabled>
          Bonding curve
        </Menu.Item>
        <Menu.Item className="mitem" nativeButton onClick={() => calls.push("log out")} render={<button type="button" />}>
          Log out
        </Menu.Item>
      </BlastMenu>
    </>
  );
}

async function mount(t: TestContext, device: Readonly<{ phone?: boolean; reduce?: boolean }> = {}): Promise<string[]> {
  media.phone = device.phone ?? false;
  media.reduce = device.reduce ?? false;
  const calls: string[] = [];
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<Page calls={calls} />));
  t.after(async () => {
    await act(async () => root.unmount());
    container.parentNode?.removeChild(container);
    motion.all.length = 0;
    live.clear();
  });
  return calls;
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector) as TestElement;
const trigger = () => $("[data-trigger]");
const menu = () => document.querySelector<HTMLElement>('[role="menu"]') as TestElement | null;
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')] as TestElement[];
const started = (element: TestElement) => motion.all.filter((animation) => animation.target === element);
const latest = (element: TestElement) => started(element).at(-1)!;
const timing = (animation: TestAnimation) => [animation.timing.duration, animation.timing.easing];

/** Time for base-ui's frame and promise turns (its animation-frame callbacks are 16 ms timers here). */
async function frames(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}

/** A mouse press and release on `element`: what a click is made of. */
async function press(element: TestElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(testEvent("pointerdown", { button: 0, pointerType: "mouse" }));
    element.dispatchEvent(testEvent("mousedown", { button: 0 }));
    element.focus();
    element.dispatchEvent(testEvent("pointerup", { button: 0, pointerType: "mouse" }));
    element.dispatchEvent(testEvent("mouseup", { button: 0 }));
    element.dispatchEvent(testEvent("click", { button: 0, detail: 1 } as never));
  });
  await frames();
}

async function key(name: string): Promise<void> {
  await act(async () => {
    (document.activeElement as TestElement).dispatchEvent(testEvent("keydown", { key: name }));
  });
  await frames();
}

/** Every running animation reaches its end, and base-ui does what it waits for. */
async function settle(): Promise<void> {
  await act(async () => motion.finishAll());
  await frames();
}

test("OA-28 M2b: the server writes only the trigger, with no inline style; the menu exists once it opens", () => {
  const html = renderToStaticMarkup(
    <LibraryProviders nonce="n0nce">
      <Page calls={[]} />
    </LibraryProviders>,
  );
  assert.doesNotMatch(html, / style="/);
  assert.doesNotMatch(html, /role="menu"|Copy link/);
  assert.match(html, /<button type="button"[^>]* aria-haspopup="menu" aria-expanded="false"[^>]* aria-label="More"/);
});

test("OA-28 M2b: desktop, the menu grows from its trigger on the click (160 ms) and shrinks away (130 ms), then is gone", async (t) => {
  await mount(t);
  const button = trigger();
  await act(async () => {
    button.dispatchEvent(testEvent("pointerdown", { button: 0, pointerType: "mouse" }));
    button.dispatchEvent(testEvent("mousedown", { button: 0 }));
  });
  await frames();
  assert.equal(menu(), null, "the press alone does not open it (the gate opens on the click)");
  await press(button);
  const popup = menu()!;
  assert.equal(popup.getAttribute("aria-label"), "Probe");
  assert.equal(popup.id, "probe-menu");
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(button.getAttribute("aria-controls"), "probe-menu");
  const open = latest(popup);
  assert.deepEqual(open.keyframes, [
    { opacity: 0, transform: "translateY(4px) scale(.98)" },
    { opacity: 1, transform: "none" },
  ]);
  assert.deepEqual(timing(open), [160, "cubic-bezier(.23,1,.32,1)"]);
  assert.equal(document.activeElement, items()[0], "every opening focuses the first item");
  // It grows from the trigger: 18px in from its right edge, from the edge that faces the trigger.
  assert.equal(popup.style.getPropertyValue("--menu-ox"), "calc(100% - 18px)");
  assert.equal(popup.getAttribute("data-side"), "bottom");
  await settle();

  await press(button);
  assert.equal(button.getAttribute("aria-expanded"), "false", "it reads as closed at once");
  assert.equal(menu(), popup, "and stays in view while it leaves");
  const close = latest(popup);
  assert.deepEqual(close.keyframes, [
    { opacity: 1, transform: "none" },
    { opacity: 0, transform: "scale(.97)" },
  ]);
  assert.deepEqual(timing(close), [130, "cubic-bezier(.23,1,.32,1)"]);
  assert.equal(close.fill, "forwards", "held at its end until base-ui unmounts it");
  await settle();
  assert.equal(menu(), null, "gone once its exit ends");
});

test("OA-28 M2b: phones, the action sheet rises from the bottom edge (240 ms) and sinks from wherever it is (180 ms)", async (t) => {
  await mount(t, { phone: true });
  await press(trigger());
  const popup = menu()!;
  const rise = latest(popup);
  assert.deepEqual(rise.keyframes, [{ transform: "translateY(calc(100% + 16px))" }, { transform: "none" }]);
  assert.deepEqual(timing(rise), [240, "cubic-bezier(.32,.72,0,1)"]);
  // Closed while it still rises: it leaves from where it is on screen, not from rest.
  live.set(popup, "matrix(1, 0, 0, 1, 0, 120)");
  await press(trigger());
  assert.equal(rise.playState, "idle", "the rise stops");
  const sink = latest(popup);
  assert.deepEqual(sink.keyframes, [{ transform: "matrix(1, 0, 0, 1, 0, 120)" }, { transform: "translateY(calc(100% + 16px))" }]);
  assert.deepEqual(timing(sink), [180, "cubic-bezier(.23,1,.32,1)"]);
  await settle();
  assert.equal(menu(), null);

  // At rest, it leaves from rest.
  live.clear();
  await press(trigger());
  await settle();
  await press(trigger());
  assert.deepEqual(latest(menu()!).keyframes[0], { transform: "none" });
});

for (const phone of [false, true]) {
  test(`reduced motion (${phone ? "phone" : "desktop"}): the menu fades in place, 120 ms in and 100 ms out, with no movement`, async (t) => {
    await mount(t, { phone, reduce: true });
    await press(trigger());
    const popup = menu()!;
    const fadeIn = latest(popup);
    assert.deepEqual(fadeIn.keyframes, [{ opacity: 0 }, { opacity: 1 }]);
    assert.deepEqual(timing(fadeIn), [120, "cubic-bezier(.23,1,.32,1)"]);
    await settle();
    await press(trigger());
    const fadeOut = latest(popup);
    assert.deepEqual(fadeOut.keyframes, [{ opacity: 1 }, { opacity: 0 }]);
    assert.deepEqual(timing(fadeOut), [100, "cubic-bezier(.23,1,.32,1)"]);
    await settle();
    assert.equal(menu(), null);
  });

  for (const reduce of [false, true]) {
    test(`keyboard (${phone ? "phone" : "desktop"}${reduce ? ", reduced motion" : ""}): the menu changes immediately, in place`, async (t) => {
      await mount(t, { phone, reduce });
      document.documentElement.dataset.blastInput = "keyboard";
      t.after(() => void delete document.documentElement.dataset.blastInput);
      await press(trigger());
      const popup = menu()!;
      assert.deepEqual(timing(latest(popup)), [0, "cubic-bezier(.23,1,.32,1)"]);
      assert.equal(latest(popup).keyframes.some((frame) => "transform" in frame), false, "no movement");
      await settle();
      await press(trigger());
      assert.deepEqual(timing(latest(popup)), [0, "cubic-bezier(.23,1,.32,1)"]);
      await settle();
      assert.equal(menu(), null);
    });
  }
}

test("OA-31 / OA-28 M2b: a menu still closing is caught: pressed again, its exit stops, it arrives again and stays", async (t) => {
  await mount(t);
  await press(trigger());
  await settle();
  const popup = menu()!;
  await press(trigger());
  const close = latest(popup);
  assert.equal(close.playState, "running", "on its way out");
  live.set(popup, "matrix(.98, 0, 0, .98, 0, 2)");
  await press(trigger());
  assert.equal(close.playState, "idle", "the reopening cancels the exit, so its end never takes the menu away");
  assert.equal(menu(), popup, "the same menu, never unmounted");
  assert.deepEqual(latest(popup).keyframes[0], { opacity: 1, transform: "matrix(.98, 0, 0, .98, 0, 2)" }, "it reopens from its visible position");
  await settle();
  assert.equal(menu(), popup, "still there once everything has run");
  assert.equal(motion.heldOpacity(popup), 1);
  assert.equal(trigger().getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement, items()[0]);
});

test("OA-28 M2b: the keys: arrows move and wrap (the disabled row takes focus too), Home and End jump, letters do nothing, Escape closes with focus back on the trigger", async (t) => {
  await mount(t);
  await press(trigger());
  await settle();
  const rows = items();
  assert.equal(rows.length, 4);
  assert.equal(document.activeElement, rows[0]);
  await key("ArrowDown");
  assert.equal(document.activeElement, rows[1], "from the first item, ArrowDown goes to the second (the gate focuses the first on opening)");
  await key("ArrowDown");
  assert.equal(document.activeElement, rows[2], "the disabled row is still reachable");
  assert.equal(rows[2]!.getAttribute("aria-disabled"), "true");
  await key("ArrowDown");
  await key("ArrowDown");
  assert.equal(document.activeElement, rows[0], "ArrowDown wraps");
  await key("ArrowUp");
  assert.equal(document.activeElement, rows[3], "ArrowUp wraps");
  await key("Home");
  assert.equal(document.activeElement, rows[0]);
  await key("End");
  assert.equal(document.activeElement, rows[3]);
  await key("a");
  await key("c");
  assert.equal(document.activeElement, rows[3], "no typeahead: the gate's menus answer only the arrows and Escape");
  await key("Escape");
  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  await settle();
  assert.equal(menu(), null);
  assert.equal(document.activeElement, trigger(), "Escape returns focus to the trigger");
});

test("OA-28 M2b: a choice closes the menu; Appearance-like rows keep it open; the disabled row does nothing", async (t) => {
  const calls = await mount(t);
  await press(trigger());
  await settle();
  await press(items()[1]!);
  assert.match(items()[1]!.textContent, /Appearance 1/);
  assert.equal(trigger().getAttribute("aria-expanded"), "true", "closeOnClick={false} keeps it open");
  await press(items()[2]!);
  assert.equal(trigger().getAttribute("aria-expanded"), "true", "the disabled row does not close it");
  await press(items()[0]!);
  assert.deepEqual(calls, ["copy"]);
  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  await settle();
  assert.equal(menu(), null);
});

test("OA-28 M2b: a press outside closes the menu and still lands; the page is not locked", async (t) => {
  const calls = await mount(t);
  await press(trigger());
  await settle();
  assert.equal(document.body.style.overflow ?? "", "", "not modal: the page keeps scrolling");
  await press($("[data-outside]"));
  assert.deepEqual(calls, ["outside"]);
  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  await settle();
  assert.equal(menu(), null);
});

test("OA-28 M2b: the Feel layer's click cue reads aria-expanded before the menu flips it: expand to open, collapse to close", async (t) => {
  await mount(t);
  const heard: (string | null)[] = [];
  const listen = (event: { target: unknown }) => {
    const target = event.target as TestElement;
    if (target.closest?.("[aria-expanded]")) heard.push(target.closest("[aria-expanded]")!.getAttribute("aria-expanded"));
  };
  document.addEventListener("click", listen, true);
  t.after(() => document.removeEventListener("click", listen, true));
  await press(trigger());
  await settle();
  await press(trigger());
  await settle();
  assert.deepEqual(heard, ["false", "true"]);
});
