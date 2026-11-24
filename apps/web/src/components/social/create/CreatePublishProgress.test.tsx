import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { installTestDom, recordAnimations } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
// jsdom has no AnimationEvent constructor; React otherwise uses a vendor event.
Object.defineProperty(dom.window, "AnimationEvent", { value: dom.window.Event });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CreatePublishProgress } = await import("./CreatePublishProgress");
const { CreateLaunchScene } = await import("./CreateLaunchScene");
const { createStore } = await import("./create-store");
const { setDevicePref } = await import("#web/components/blast-ui/device-prefs.ts");
const { filledSample } = await import("../../../../../../packages/core/test/fixtures/social/create/create-fixtures.ts");
const ID = `0x${"1".repeat(64)}`;

function scene(progress: string | null, extra = {}) {
  createStore.reset({ phase: "ready", draft: filledSample(), publish: { available: true }, publishLocked: true, publishProgress: progress, ...extra });
  const container = dom.document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<CreatePublishProgress state={createStore.get()} onRetry={() => undefined} />);
  return container;
}

test("the signing sheet shows every step at its natural height: the whole sheet scrolls, with the action stuck below a fade", () => {
  const css = readFileSync(new URL("./create.module.css", import.meta.url), "utf8");
  const launch = css.match(/\.cr-launch \{([^}]*)\}/)![1];
  assert.doesNotMatch(launch, /overflow-y|min-height: 0|flex: 1/, "the step list is not an inner scroll box");
  assert.match(css, /\.cr-sheet\.cr-sheet:has\(> \.cr-launch\) \{ overflow-x: hidden; overflow-y: auto; \}/);
  // Paused on a short screen, the error, the steps, the note and the button fit without scrolling: tighter gaps, no orbits or sparks.
  // A bare [data-paused] matches "false" too: it once shrank the running scene to half size and hid its tickers.
  for (const sheet of [css, readFileSync(new URL("../launch/launch.module.css", import.meta.url), "utf8")]) assert.doesNotMatch(sheet, /\[data-paused\]/);
  // Paused, the scene scales under .8, so its words (tickers, the venue's name) hide; the venue keeps its mark.
  assert.match(css, /\.cr-launch\[data-paused="true"\] :is\(\.cr-launch-ticker, \.cr-launch-venue > span > span\) \{ display: none; \}/);
  const short = css.slice(css.indexOf("@media (max-height: 900px)"));
  assert.match(short, /\.cr-launch:has\(> \.cr-launch-error\) \{ gap: 0\.625rem; \}/);
  assert.match(short, /\.cr-launch\[data-paused="true"\] :is\(\.cr-launch-registry, \.cr-launch-spark\) \{ display: none; \}/);
  assert.match(css, /\.cr-sheet:has\(> \.cr-launch\) > \.cr-cta \{ position: sticky; bottom: 0; background: linear-gradient\(to bottom, transparent, var\(--card\) 1\.3125rem\); \}/);
});

test("creation advances only with real operations and never reports the future pool as created", () => {
  for (const [progress, completed] of [
    ["Save draft", 0],
    ["1 of 4 · Publish coin", 0],
    ["2 of 4 · Register currency", 1],
    ["3 of 4 · Create presale", 2],
    ["4 of 4 · Finalizing coin", 3],
  ] as const) {
    const container = scene(progress);
    assert.equal(container.querySelectorAll('[data-complete="true"]').length, completed);
    assert.equal(container.querySelector("a[href]"), null, "no destination is advertised before the flow returns it");
    assert.equal(container.querySelector<HTMLButtonElement>("button")!.disabled, true);
    assert.equal(container.querySelector(".cr-launch-flight"), null, "no celebration before recorded success");
    assert.equal(container.querySelectorAll("ol > li").length, 4);
    if (progress !== "Save draft") assert.equal(container.querySelector('[aria-current="step"] > span:nth-child(2)')!.textContent, ["Publish $MRDN", "Register the currency", "Create the presale", "Finalize the coin"][completed], "the sheet's labels are the review list's");
    // A running stage has no subtitle: the step in progress already says it (TS-2).
    if (progress !== "Save draft") assert.equal(container.querySelector(".cr-launch-copy p"), null);
  }
  const resume = scene(null);
  // Four rows under one honest heading (three of them are signatures; the review card lists those three).
  const list = resume.querySelector("ol")!;
  assert.equal(resume.querySelector(`#${list.getAttribute("aria-labelledby")}`)?.textContent, "Publishing steps");
  assert.equal(resume.querySelectorAll("ol > li").length, 4);
  assert.equal(resume.querySelectorAll('[data-complete="true"]').length, 0, "a restored checkpoint isn't assumed confirmed before it is checked");
  assert.equal(resume.querySelector<HTMLButtonElement>("button")!.disabled, false);
});

test("the open creation scene follows live reduced-motion changes and keeps later stages static", async () => {
  const matchMedia = dom.window.matchMedia;
  const media = new dom.window.EventTarget();
  let reduced = false;
  dom.window.matchMedia = (query) => query === "(prefers-reduced-motion: reduce)" ? {
    ...matchMedia(query),
    get matches() { return reduced; },
    addEventListener: media.addEventListener.bind(media),
    removeEventListener: media.removeEventListener.bind(media),
  } : matchMedia(query);
  const motion = recordAnimations();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  createStore.reset({ phase: "ready", draft: filledSample() });
  const render = (stage: number) => {
    const { draft, logoPreview, logoUrl } = createStore.get();
    return <CreateLaunchScene logo={logoPreview ?? logoUrl} name={draft.name} published={false} quoteSymbol="SUI" stage={stage} symbol={draft.symbol} venue={draft.venue} />;
  };
  try {
    await act(async () => root.render(render(0)));
    const scene = container.querySelector<HTMLElement>(".cr-launch-scene")!;
    const coin = container.querySelector<HTMLElement>(".cr-launch-coin")!;
    assert.equal(scene.dataset.motion, "true");
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await act(async () => motion.finishAll());
    await act(async () => root.render(render(2)));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.ok(motion.all.some(animation => animation.target === coin && animation.playState === "running" && animation.timing.duration === 500), "interrupt a spring that has already started");
    reduced = true;
    await act(async () => media.dispatchEvent(new dom.window.Event("change")));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(scene.dataset.motion, "false", "the preference updates without remounting");
    assert.match(coin.style.transform, /translateX\(-58px\)/, "reduced motion snaps the interrupted spring to the paired position");
    const animations = motion.all.length;
    await act(async () => root.render(render(3)));
    assert.equal(motion.all.length, animations, "the next publish stage does not start a spring");
    assert.match(coin.style.transform, /translateX\(-58px\)/);
    reduced = false;
    await act(async () => media.dispatchEvent(new dom.window.Event("change")));
    assert.equal(scene.dataset.motion, "true", "normal motion can resume without remounting");
    await act(async () => root.render(render(0)));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.ok(motion.all.some(animation => animation.target === coin && animation.playState === "running" && animation.timing.duration === 500), "normal motion resumes for the next position change");
    await act(async () => motion.finishAll());
    assert.match(coin.style.transform, /translateX\(0px\)/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.matchMedia = matchMedia;
    createStore.reset();
  }
});

test("a mounted publication scene pairs the coins through real stages and preserves its completed destination", async () => {
  const motion = recordAnimations();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  try {
    for (const [progress, stage] of [
      ["1 of 4 · Publish coin", 0],
      ["2 of 4 · Register currency", 1],
      ["3 of 4 · Create presale", 2],
      ["4 of 4 · Finalizing coin", 3],
    ] as const) {
      createStore.reset({ phase: "ready", draft: filledSample(), publish: { available: true }, publishLocked: true, publishProgress: progress });
      await act(async () => root.render(<CreatePublishProgress state={createStore.get()} />));
      // Motion resolves keyframes on the next frame before creating the native animation.
      await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      if (stage === 2) assert.ok(motion.all.some(animation => animation.target === container.querySelector(".cr-launch-coin") && animation.playState === "running" && animation.timing.duration === 500), "pairing starts its spring after Motion resolves the keyframes");
      await act(async () => motion.finishAll());
      assert.equal(container.querySelector<HTMLElement>(".cr-launch")!.dataset.stage, String(stage));
      // Floor 1: the scaled scene carries no caption; the title and steps say the stage.
      assert.equal(container.querySelector(".cr-launch-scene-label"), null);
      assert.match(container.querySelector<HTMLElement>(".cr-launch-coin")!.style.transform, stage >= 2 ? /translateX\(-58px\)/ : /translateX\(0px\)/);
      assert.equal(container.querySelectorAll('[data-complete="true"]').length, stage);
    }
    createStore.set({ publishedPresaleId: ID });
    await act(async () => root.render(<CreatePublishProgress state={createStore.get()} />));
    assert.equal(container.querySelector(".cr-launch-scene-label"), null);
    assert.equal(container.querySelectorAll('[data-complete="true"]').length, 4);
    assert.equal(container.querySelector("a")!.getAttribute("href"), `/presale/${ID}`);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    createStore.reset();
  }
});

test("an on-chain success with a failed metadata save preserves confirmed steps and exposes a retry", async () => {
  createStore.reset({ phase: "ready", draft: filledSample(), publish: { available: true }, publishLocked: true, publishProgress: "4 of 4 · Finalizing coin", publishError: "Your presale is on-chain. Retry to finish saving its cover. Code: metadata_failed." });
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  let retries = 0;
  try {
    await act(async () => root.render(<CreatePublishProgress state={createStore.get()} onRetry={() => { retries++; }} />));
    assert.equal(container.querySelectorAll('[data-complete="true"]').length, 3);
    assert.equal(container.querySelector('[aria-current="step"] > span:nth-child(2)')!.textContent, "Finalize the coin");
    assert.equal(container.querySelector('[aria-current="step"] > small')!.textContent, "Paused");
    assert.match(container.querySelector("h2")!.textContent ?? "", /on-chain/);
    assert.match(container.querySelector('[role="alert"]')!.textContent ?? "", /Retry/);
    assert.equal(container.querySelector('[role="alert"] .err-code')!.textContent, " Code: metadata_failed.");
    assert.equal(container.querySelector(".snote")!.textContent, "Your progress is saved.", "paused: one muted line under the steps says it, once");
    assert.equal(container.textContent!.match(/saved\b/g)?.length, 1);
    assert.equal(container.querySelector(".cr-launch-flight"), null);
    const button = container.querySelector<HTMLButtonElement>("button")!;
    assert.equal(button.textContent, "Retry finalization");
    assert.equal(button.disabled, false);
    await act(async () => button.click());
    assert.equal(retries, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    createStore.reset();
  }
});

test("a refused publish on the paused sheet says what failed; only the note says progress is saved", () => {
  const paused = scene("1 of 4 · Publish coin", {
    publish: { available: false, reasons: ["quote_unavailable"] },
    publishError: "No allowed raise coin is available right now. Code: publish_unavailable.",
  });
  const text = paused.textContent!;
  assert.equal(paused.querySelector(".snote")!.textContent, "Your progress is saved.");
  assert.equal(text.match(/saved\b/gi)?.length, 1, "the banner and the off line leave the saved point to the note");
  // The scene has no caption and the paused sheet no subtitle: the banner, the note and the button say what happens next.
  assert.equal(paused.querySelector(".cr-launch-scene-label"), null);
  assert.equal(paused.querySelector(".cr-launch-copy p"), null);
  assert.equal(text.match(/No allowed raise coin is available right now\./g)?.length, 2, "banner and off line, both without the saved words");
  createStore.reset();
});

test("recorded success presents a durable presale link and reduced motion suppresses the rocket", async () => {
  const matchMedia = dom.window.matchMedia;
  dom.window.matchMedia = (query) => ({ ...matchMedia(query), matches: query === "(prefers-reduced-motion: reduce)" });
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  createStore.reset({ phase: "ready", draft: filledSample(), publishedPresaleId: ID });
  try {
    await act(async () => root.render(<CreatePublishProgress state={createStore.get()} />));
    assert.equal(container.querySelectorAll('[data-complete="true"]').length, 4);
    assert.equal(container.querySelector("ol > li:last-child small")!.textContent, "Saved");
    assert.match(container.querySelector("h2")!.textContent ?? "", /presale is published/);
    assert.equal(container.querySelector("a")!.getAttribute("href"), `/presale/${ID}`);
    assert.match(container.querySelector("a")!.textContent ?? "", /View presale/);
    assert.equal(container.querySelector("button"), null);
    assert.equal(container.querySelector(".cr-launch-flight"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.matchMedia = matchMedia;
    createStore.reset();
  }
});


test("the rocket starts after loading, flies once, and leaves when celebrations are disabled or the sheet unmounts", async () => {
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  container.innerHTML = '<div data-sheet-scrim><div class="cr-sheet"></div></div>';
  dom.document.body.append(container);
  const root = createRoot(container.querySelector(".cr-sheet")!);
  createStore.reset({ phase: "ready", draft: filledSample(), publishedPresaleId: ID });
  try {
    await act(async () => root.render(<CreatePublishProgress state={createStore.get()} />));
    const flight = container.querySelector("[data-sheet-scrim] > .cr-launch-flight")!;
    assert.equal(flight.parentElement, container.querySelector("[data-sheet-scrim]"), "the flight shares the sheet's stacking context above the blurred backdrop");
    assert.equal(dom.document.activeElement, container.querySelector("h2"), "decoration does not steal success focus");
    assert.equal(flight.getAttribute("aria-hidden"), "true");
    const rocket = flight.querySelector<HTMLElement>(".cr-launch-rocket")!;
    const sprite = rocket.querySelector<HTMLImageElement>("img")!;
    assert.equal(sprite.getAttribute("src"), "/celebration/blast-piloted-rocket.webp");
    assert.equal(sprite.alt, "");
    assert.equal(rocket.dataset.flying, undefined, "wait for the asset before starting");
    await act(async () => sprite.dispatchEvent(new dom.window.Event("load")));
    assert.equal(rocket.dataset.flying, "true");
    await act(async () => sprite.dispatchEvent(new dom.window.Event("animationend", { bubbles: true })));
    assert.equal(rocket.dataset.flying, "true", "only the flight ending can dismiss the rocket");
    await act(async () => rocket.dispatchEvent(new dom.window.Event("animationend", { bubbles: true })));
    assert.equal(rocket.dataset.flying, "false");
    await act(async () => root.render(<CreatePublishProgress state={createStore.get()} />));
    assert.equal(rocket.dataset.flying, "false", "ordinary rerenders do not replay the flight");
    await act(async () => setDevicePref("celebrate", false));
    assert.equal(container.querySelector(".cr-launch-flight"), null);
    await act(async () => setDevicePref("celebrate", true));
    assert.ok(container.querySelector(".cr-launch-flight"));
    await act(async () => root.render(null));
    assert.equal(container.querySelector(".cr-launch-flight"), null);
  } finally {
    await act(async () => root.unmount());
    setDevicePref("celebrate", true);
    container.remove();
    createStore.reset();
  }
});
