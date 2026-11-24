import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { installTestDom, recordAnimations, testEvent, type TestAnimation, type TestElement } from "../../../test/fixtures/social/test-dom.ts";

/**
 * OA-28 M2: the shared `Sheet` on base-ui's `Dialog`, with the gate's version 5
 * motion and pull-down (OA-31), rendered in the test DOM the way a page
 * renders it (inside the Blast UI root, where base-ui portals it).
 *
 * The device is chosen per test: `(max-width: 760px)` and
 * `(prefers-reduced-motion: reduce)` answer what the test sets, and the
 * computed `transform` is the element's inline one (the test DOM has no
 * layout), so an exit can be seen to start where a pull left the sheet.
 */

const { document, window } = installTestDom();
const motion = recordAnimations();
Object.defineProperty(window, "innerHeight", { value: 844, configurable: true, writable: true });

const media = { phone: false, reduce: false };
const query = (text: string) => {
  const matches = /max-width:\s*760px/.test(text) ? media.phone : /prefers-reduced-motion:\s*reduce/.test(text) ? media.reduce : false;
  return { matches, media: text, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
};
const asMatrix = (transform: unknown) => {
  const y = /^translateY\((-?[\d.e+-]+)px\)$/.exec(String(transform ?? ""));
  return y === null ? "none" : `matrix(1, 0, 0, 1, 0, ${y[1]})`;
};
const computed = (element: TestElement) => ({ transform: asMatrix(element.style?.transform), opacity: String(element.style?.opacity ?? "1"), overflowY: "auto" });
Object.assign(window, { matchMedia: query, getComputedStyle: computed });
Object.assign(globalThis, { matchMedia: query, getComputedStyle: computed });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Sheet, SheetClose, useSheet } = await import("./Sheet");
const { springFrames } = await import("./sheet-gesture-model");

type Calls = Readonly<{ requests: number[]; closed: number[] }>;

function Steps() {
  const { swap } = useSheet();
  const [step, setStep] = useState(1);
  return (
    <button data-step={step} onClick={() => swap(() => setStep(step + 1))} type="button">
      Step {step}
    </button>
  );
}

/** A page with one sheet; `hold` keeps it open whatever asks (an owner busy signing, say). */
function Page({ calls, hold = false }: Readonly<{ calls: Calls; hold?: boolean }>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <main data-page="">
        <button data-open="" onClick={() => setOpen(true)} type="button">
          Deposit
        </button>
      </main>
      <Sheet
        labelledBy="deposit-title"
        onClosed={() => void calls.closed.push(Date.now())}
        onRequestOpen={() => setOpen(true)}
        onRequestClose={() => {
          calls.requests.push(Date.now());
          if (!hold) setOpen(false);
        }}
        open={open}
      >
        <SheetClose onClick={() => setOpen(false)} />
        <h2 id="deposit-title">Deposit USDC</h2>
        <Steps />
      </Sheet>
    </>
  );
}

async function mount(t: TestContext, device: Readonly<{ phone?: boolean; reduce?: boolean }> = {}, hold = false): Promise<Calls> {
  media.phone = device.phone ?? false;
  media.reduce = device.reduce ?? false;
  const calls: Calls = { requests: [], closed: [] };
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<Page calls={calls} hold={hold} />));
  t.after(async () => {
    await act(async () => root.unmount());
    container.parentNode?.removeChild(container);
    motion.all.length = 0;
    assert.equal(document.body.style.overflow, "", "leaving the page leaves it unlocked");
  });
  return calls;
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector) as TestElement;
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]') as TestElement | null;
const scrim = () => sheet()!.parentElement!;
const started = (element: TestElement) => motion.all.filter((animation) => animation.target === element);
const latest = (element: TestElement) => started(element).at(-1)!;
const timing = (animation: TestAnimation) => [animation.timing.duration, animation.timing.easing];

async function open(): Promise<void> {
  const button = $("[data-open]");
  button.focus();
  await act(async () => button.click());
}

async function settle(): Promise<void> {
  await act(async () => motion.finishAll());
}

let clock = 5_000;

function touch(target: TestElement, type: string, y: number): void {
  const event = testEvent(type, { timeStamp: clock, cancelable: true } as never) as ReturnType<typeof testEvent> & { touches: unknown };
  event.touches = type === "touchend" || type === "touchcancel" ? [] : [{ clientX: 195, clientY: y }];
  target.dispatchEvent(event);
}

/** A finger on the grabber, pulling down through `ys`, 16 ms apart, then lifting `rest` ms after the last move. */
async function pull(ys: readonly number[], rest = 4): Promise<void> {
  const target = sheet()!;
  await act(async () => {
    touch(target, "touchstart", 10);
    for (const y of ys) {
      clock += 16;
      touch(target, "touchmove", y);
    }
    clock += rest;
    touch(target, "touchend", 0);
  });
}

test("OA-28 M2: before hydration a sheet open on arrival is the dialog's static markup (no inline style); a closed one is nothing", () => {
  const html = renderToStaticMarkup(
    <Sheet hasCta labelledBy="t" onRequestClose={() => undefined} open>
      <h2 id="t">Join Blast</h2>
    </Sheet>,
  );
  assert.equal(html, '<div class="scrim" data-sheet-scrim=""><dialog aria-labelledby="t" aria-modal="true" class="sheet hasCta" open="" tabindex="-1"><h2 id="t">Join Blast</h2></dialog></div>');
  assert.doesNotMatch(html, / style="/);
  assert.equal(
    renderToStaticMarkup(
      <Sheet labelledBy="t" onRequestClose={() => undefined} open={false}>
        <h2 id="t">Join Blast</h2>
      </Sheet>,
    ),
    "",
  );
});

test("OA-28 M2: in the browser it is base-ui's dialog, portalled into the Blast UI root: named, modal, the page hidden from assistive tech while it is open", async (t) => {
  await mount(t);
  await open();
  const dialog = sheet()!;
  assert.equal(dialog.getAttribute("aria-labelledby"), "deposit-title");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(scrim().getAttribute("data-sheet-scrim"), "");
  assert.ok(scrim().parentElement!.hasAttribute("data-base-ui-portal"), "base-ui's portal");
  assert.ok($("[data-blast-ui]").contains(dialog), "inside the root, so the tokens and the theme apply");
  assert.equal($("main[data-page]").getAttribute("aria-hidden"), "true", "the page behind is hidden from assistive tech");
  assert.ok(document.activeElement === dialog, "focus moves in (no first action named: the sheet itself)");
  assert.equal(document.body.style.overflow, "hidden");
  await act(async () => $('[aria-label="Close"]').click());
  assert.equal(dialog.getAttribute("aria-modal"), null, "closing, it is no longer modal");
  assert.equal(scrim().getAttribute("data-closing"), "");
  await settle();
  assert.equal(sheet(), null);
  assert.equal($("main[data-page]").getAttribute("aria-hidden"), null);
  assert.ok(document.activeElement === $("[data-open]"), "focus is back on Deposit");
});

test("OA-31: wider than a phone it pops in (scrim 180 ms, sheet 200 ms from 6 px below) and leaves in 160 ms", async (t) => {
  const calls = await mount(t);
  await open();
  const [fadeIn] = started(scrim());
  const [pop] = started(sheet()!);
  assert.deepEqual(fadeIn!.keyframes, [{ opacity: 0 }, { opacity: 1 }]);
  assert.deepEqual(timing(fadeIn!), [180, "cubic-bezier(.23,1,.32,1)"]);
  assert.deepEqual(pop!.keyframes, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }]);
  assert.deepEqual(timing(pop!), [200, "cubic-bezier(.23,1,.32,1)"]);
  await settle();
  const dialog = sheet()!;
  await act(async () => void document.body.dispatchEvent(testEvent("keydown", { key: "Escape" })));
  assert.equal(calls.requests.length, 1);
  const out = latest(dialog);
  assert.deepEqual(out.keyframes, [{ opacity: 1, transform: "translateY(0px)" }, { opacity: 0, transform: "translateY(6px)" }]);
  assert.deepEqual([...timing(out), out.fill], [160, "cubic-bezier(.23,1,.32,1)", "forwards"]);
  await settle();
  assert.equal(calls.closed.length, 1);
});

test("OA-31: on a phone it rises 200 ms from the bottom edge, and leaves from wherever it is drawn", async (t) => {
  await mount(t, { phone: true });
  await open();
  const rise = latest(sheet()!);
  assert.deepEqual(rise.keyframes, [{ transform: "translateY(100%)" }, { transform: "none" }]);
  assert.deepEqual(timing(rise), [200, "cubic-bezier(.32,.72,0,1)"]);
  await settle();
  const dialog = sheet()!;
  dialog.style.transform = "translateY(37px)";
  scrim().style.opacity = "0.6";
  await act(async () => $('[aria-label="Close"]').click());
  assert.deepEqual(latest(dialog).keyframes, [{ transform: "translateY(37px)" }, { transform: "translateY(100%)" }]);
  assert.deepEqual(timing(latest(dialog)), [160, "cubic-bezier(.23,1,.32,1)"]);
  assert.deepEqual(latest(scrim()).keyframes, [{ opacity: 0.6 }, { opacity: 0 }], "the scrim fades from where it was");
  await settle();
});

test("reduced motion: the sheet and scrim fade over 160 ms where they stand; step changes are immediate", async (t) => {
  await mount(t, { phone: true, reduce: true });
  await open();
  const dialog = sheet()!;
  assert.deepEqual(latest(dialog).keyframes, [{ opacity: 0 }, { opacity: 1 }]);
  assert.deepEqual(timing(latest(dialog)), [160, "cubic-bezier(.23,1,.32,1)"]);
  assert.equal(timing(latest(scrim()))[0], 160);
  await settle();
  const before = started(dialog).length;
  await act(async () => $("[data-step]").click());
  assert.equal($("[data-step]").getAttribute("data-step"), "2");
  assert.equal(started(dialog).length, before, "the step swaps immediately without WAAPI work");
  await act(async () => $('[aria-label="Close"]').click());
  const leave = latest(dialog);
  assert.deepEqual([leave.keyframes[0]!.opacity, leave.keyframes[1]!.opacity], [1, 0]);
  assert.equal(leave.keyframes[0]!.transform, leave.keyframes[1]!.transform, "no movement");
  assert.deepEqual(timing(leave), [160, "cubic-bezier(.23,1,.32,1)"]);
  assert.equal(timing(latest(scrim()))[0], 160);
  await settle();
});

for (const reduce of [false, true]) {
  test(`keyboard${reduce ? " with reduced motion" : ""}: opening and closing have no animation`, async (t) => {
    document.documentElement.dataset.blastInput = "keyboard";
    t.after(() => void delete document.documentElement.dataset.blastInput);
    await mount(t, { phone: true, reduce });
    await open();
    const dialog = sheet()!;
    assert.equal(timing(latest(dialog))[0], 0);
    assert.equal(timing(latest(scrim()))[0], 0);
    await settle();
    await act(async () => $('[aria-label="Close"]').click());
    assert.equal(timing(latest(dialog))[0], 0);
    assert.equal(timing(latest(scrim()))[0], 0);
    await settle();
  });
}

test("OA-31: a step swap slides out left 8 px (60 ms) and in from the right (120 ms)", async (t) => {
  await mount(t);
  await open();
  await settle();
  const dialog = sheet()!;
  await act(async () => $("[data-step]").click());
  assert.deepEqual(latest(dialog).keyframes, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-8px)" }]);
  assert.deepEqual(timing(latest(dialog)), [60, "cubic-bezier(.23,1,.32,1)"]);
  await settle();
  const swapIn = started(dialog).find((animation) => animation.keyframes[0]?.transform === "translateX(8px)")!;
  assert.deepEqual(timing(swapIn), [120, "cubic-bezier(.23,1,.32,1)"]);
  assert.equal($("[data-step]").getAttribute("data-step"), "2");
});

test("OA-31: pulled down past half on a phone, it asks to close and leaves from the finger at the finger's speed", async (t) => {
  const calls = await mount(t, { phone: true });
  await open();
  await settle();
  const dialog = sheet()!;
  // 40 px every 16 ms (2,500 px/s), to 320 px, lifted at once.
  await pull([20, ...Array.from({ length: 8 }, (_, index) => 60 + 40 * index)]);
  assert.equal(calls.requests.length, 1);
  const out = latest(dialog);
  assert.deepEqual(out.keyframes, [{ transform: "translateY(320px)" }, { transform: "translateY(100%)" }]);
  // 3 × (844 − 320) / 2,500 px/s = 628.8 ms, capped at 360; the fling's ease.
  assert.deepEqual(timing(out), [360, "cubic-bezier(.25,.75,.5,1)"]);
  assert.equal(timing(latest(scrim()))[0], 360);
  await settle();
  assert.equal(sheet(), null);
  assert.equal(calls.closed.length, 1);
});

test("OA-31: pulled a little and let go, it springs home; a sheet its owner keeps open springs home after a pull past half", async (t) => {
  const calls = await mount(t, { phone: true }, true);
  await open();
  await settle();
  const dialog = sheet()!;
  await pull([20, 60, 100], 100);
  assert.equal(calls.requests.length, 0);
  assert.deepEqual(
    latest(dialog).keyframes.map((frame) => frame.transform),
    springFrames(80, 0).map((y) => `translateY(${y}px)`),
  );
  await settle();
  await pull([20, 520], 100);
  assert.equal(calls.requests.length, 1, "asked to close");
  assert.equal(dialog.style.transform, "translateY(500px)");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
  assert.equal(dialog.style.transform, "", "held open: rest is the inline state again");
  assert.deepEqual(
    latest(dialog).keyframes.map((frame) => frame.transform),
    springFrames(500, 0).map((y) => `translateY(${y}px)`),
  );
});

test("OA-31: caught mid-open, the rise is finished (not cancelled) and the pull starts there; wider than a phone nothing pulls", async (t) => {
  await mount(t, { phone: true });
  await open();
  const rise = latest(sheet()!);
  assert.equal(rise.playState, "running");
  await pull([20, 40], 100);
  assert.equal(rise.playState, "finished");
  await settle();
  media.phone = false;
  const dialog = sheet()!;
  const before = started(dialog).length;
  await pull([20, 120, 220, 320, 420, 520], 4);
  assert.equal(dialog.style.transform ?? "", "");
  assert.equal(started(dialog).length, before, "no spring, no exit");
});

test("reopened while closing, a sheet springs home from its live position without restarting the entrance", async (t) => {
  await mount(t, { phone: true });
  await open();
  await settle();
  await act(async () => $('[aria-label="Close"]').click());
  const exit = latest(sheet()!);
  sheet()!.style.transform = "translateY(120px)";
  scrim().style.opacity = "0.4";
  await act(async () => $("[data-open]").click());
  assert.equal(exit.playState, "idle", "the exit was cancelled where it was");
  assert.deepEqual(latest(sheet()!).keyframes.map((frame) => frame.transform), springFrames(120, 0).map((y) => `translateY(${y}px)`));
  assert.deepEqual(latest(scrim()).keyframes, [{ opacity: 0.4 }, { opacity: 1 }]);
  assert.equal(sheet()!.getAttribute("aria-modal"), "true");
  await settle();
  assert.ok(sheet() !== null, "and stays");
});

test("OA-28 M2: Escape is heard on the document: with focus fallen to <body> it still closes the sheet, and focus inside asks once", async (t) => {
  const calls = await mount(t);
  await open();
  await settle();
  sheet()!.blur();
  assert.ok(document.activeElement === document.body);
  await act(async () => void document.body.dispatchEvent(testEvent("keydown", { key: "Escape" })));
  assert.equal(calls.requests.length, 1);
  await settle();
  await open();
  await settle();
  const step = $("[data-step]");
  step.focus();
  const escape = testEvent("keydown", { key: "Escape" });
  await act(async () => void step.dispatchEvent(escape));
  assert.equal(calls.requests.length, 2, "the popup's handler and the document's: one request");
  assert.equal(escape.defaultPrevented, true);
  await settle();
});


test("a closing phone sheet can be caught and pulled back; it stays modal after settling", async (t) => {
  const calls = await mount(t, { phone: true });
  await open();
  await settle();
  const dialog = sheet()!;
  await act(async () => $('[aria-label="Close"]').click());
  const exit = latest(dialog);
  dialog.style.transform = "translateY(120px)";
  await pull([20, 40], 100);
  assert.equal(exit.playState, "idle");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(latest(dialog).keyframes[0]!.transform, "translateY(20px)", "the pull continues after reopening rerenders its callback");
  await settle();
  assert.equal(sheet(), dialog);
  assert.equal(calls.closed.length, 0);
});

test("reduced motion returns a dragged sheet directly to rest, including when dismissal is refused", async (t) => {
  const calls = await mount(t, { phone: true, reduce: true }, true);
  await open();
  await settle();
  const dialog = sheet()!;
  const before = started(dialog).length;
  await pull([20, 40], 100);
  assert.equal(dialog.style.transform, "");
  assert.equal(started(dialog).length, before);
  await pull([20, 520], 100);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
  assert.equal(calls.requests.length, 1);
  assert.equal(dialog.style.transform, "");
  assert.equal(started(dialog).length, before);
});
