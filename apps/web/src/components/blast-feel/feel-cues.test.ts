import assert from "node:assert/strict";
import test from "node:test";

import {
  FEEL_ATTACK_MS,
  FEEL_MASTER_GAIN,
  FEEL_RELEASE_TAIL_MS,
  FEEL_TICK_STEPS,
  keyPressSignal,
  ownSignal,
  pointerPressSignal,
  pressableFrom,
  voicesFor,
  type FeelNode,
} from "./feel-cues.ts";

/**
 * OA-23 / FEEL-LAYER.md §1: the cue table and the one press rule, held to the
 * numbers measured in Chrome against the gate (`design/blast-feel-preview.html`,
 * sha256 `dd8cb26c…`) with `AudioContext.createOscillator` instrumented. A
 * measured length is `durationMs + FEEL_RELEASE_TAIL_MS`, because the gate
 * stops each oscillator after the decay rather than at it.
 */

/** A stand-in for an element: the selectors it matches, plus its parent. */
type Fake = FeelNode & { parent: Fake | null };

function node(
  selectors: readonly string[],
  options: Readonly<{ tagName?: string; disabled?: boolean; attributes?: Readonly<Record<string, string>>; parent?: Fake | null }> = {},
): Fake {
  const own = new Set(selectors);
  const attributes = options.attributes ?? {};
  const self: Fake = {
    tagName: options.tagName ?? "BUTTON",
    parent: options.parent ?? null,
    matches(list: string) {
      return list.split(",").some((part) => own.has(part.trim()));
    },
    closest(list: string) {
      let at: Fake | null = self;
      while (at) {
        if (at.matches(list)) return at;
        at = at.parent;
      }
      return null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
  if (options.disabled !== undefined) Object.defineProperty(self, "disabled", { value: options.disabled, enumerable: true });
  return self;
}

test("the envelope and the master level are the gate's", () => {
  assert.equal(FEEL_MASTER_GAIN, 0.32);
  assert.equal(FEEL_ATTACK_MS, 6);
  assert.equal(FEEL_RELEASE_TAIL_MS, 30);
});

test("every fixed cue matches the frequency, wave, glide and length measured in the gate", () => {
  // Measured: "<hz>[→x<glide>]/<measured ms>/<wave>".
  const measured: Readonly<Record<string, string>> = {
    tap: "880/75/triangle",
    fire: "260→x2.6/230/sine",
    open: "440→x1.4/130/sine",
    close: "560→x0.7/130/sine",
    expand: "392→x1.25/110/sine",
    collapse: "490→x0.8/110/sine",
  };
  for (const [kind, expected] of Object.entries(measured)) {
    const voices = voicesFor({ kind } as never);
    assert.equal(voices.length, 1, kind);
    const voice = voices[0]!;
    const glide = voice.glide === undefined ? "" : `→x${voice.glide}`;
    assert.equal(`${voice.hz}${glide}/${voice.durationMs + FEEL_RELEASE_TAIL_MS}/${voice.wave}`, expected, kind);
  }
});

test("land, claim, chord and error are phrases with the gate's offsets", () => {
  // Measured after a held blast: 659.25/270 then 987.77/370.
  const land = voicesFor({ kind: "land" });
  assert.deepEqual(
    land.map((v) => [v.hz, v.durationMs + FEEL_RELEASE_TAIL_MS, v.atMs ?? 0]),
    [
      [659.25, 270, 0],
      [987.77, 370, 45],
    ],
  );
  assert.deepEqual(voicesFor({ kind: "claim" }).map((v) => [v.hz, v.atMs ?? 0]), [
    [523.25, 0],
    [659.25, 60],
    [783.99, 120],
  ]);
  assert.deepEqual(voicesFor({ kind: "chord" }).map((v) => [v.hz, v.atMs ?? 0, v.durationMs]), [
    [523.25, 0, 700],
    [659.25, 80, 700],
    [783.99, 160, 700],
    [1046.5, 240, 700],
  ]);
  assert.deepEqual(voicesFor({ kind: "error" }).map((v) => [v.hz, v.wave, v.atMs ?? 0]), [
    [220, "triangle", 0],
    [185, "triangle", 90],
  ]);
});

test("the charge ticks walk the pentatonic climb and clamp at its top", () => {
  // Measured over a charge to $500: 523.25, 588.66, 654.06, all triangle/110.
  const hz = (level: number) => voicesFor({ kind: "tick", level }).map((v) => Math.round(v.hz * 100) / 100);
  assert.deepEqual(hz(0), [523.25]);
  assert.deepEqual(hz(1), [588.66]);
  assert.deepEqual(hz(2), [654.06]);
  const top = hz(FEEL_TICK_STEPS.length - 1);
  assert.deepEqual(hz(99), top, "a level past the ladder stays on the last step");
  assert.deepEqual(hz(-5), [523.25], "a negative level is the root");
  const voice = voicesFor({ kind: "tick", level: 0 })[0]!;
  assert.equal(voice.wave, "triangle");
  assert.equal(voice.durationMs + FEEL_RELEASE_TAIL_MS, 110);
});

test("a switch ticks up for on and down for off; follow rises and falls", () => {
  // Measured: clicking a checked switch gives 494, clicking it back gives 740.
  assert.equal(voicesFor({ kind: "toggle", on: true })[0]!.hz, 740);
  assert.equal(voicesFor({ kind: "toggle", on: false })[0]!.hz, 494);
  assert.deepEqual(voicesFor({ kind: "follow", on: true }).map((v) => v.hz), [659.25, 987.77]);
  assert.deepEqual(voicesFor({ kind: "follow", on: false }).map((v) => v.hz), [783.99, 523.25]);
  assert.equal(voicesFor({ kind: "follow", on: true })[1]!.atMs, 70);
});

test("anything you can press answers with one tap; a field, a disabled control and a right button do not", () => {
  const link = node(["a[href]"], { tagName: "A" });
  assert.equal(pointerPressSignal(0, link)?.kind, "tap");
  // Measured: a right-button press on a Blast button produced no cue at all.
  assert.equal(pointerPressSignal(2, link), null);
  assert.equal(pointerPressSignal(1, link), null);

  for (const selector of ['[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="menuitemradio"]', '[role="button"]', "summary", "[data-act]", "[data-bx]", ".bx-card", "[data-feel-press]"]) {
    assert.equal(pointerPressSignal(0, node([selector]))?.kind, "tap", selector);
  }

  assert.equal(pointerPressSignal(0, node(["button"], { disabled: true })), null, "a disabled control is silent");
  assert.equal(pointerPressSignal(0, node(["input"], { tagName: "INPUT" })), null, "a field is silent");
  assert.equal(pointerPressSignal(0, node([], { tagName: "SPAN" })), null, "plain text is silent");
  assert.equal(pointerPressSignal(0, null), null);
});

test("the press cue finds the pressable ancestor of whatever was hit", () => {
  const button = node(["button"]);
  const icon = node([], { tagName: "SVG", parent: button });
  assert.equal(pressableFrom(icon), button);
});

test("a control with a cue of its own gets no tap on top of it", () => {
  // The gate's OWN list: a switch, anything that opens or closes, follow.
  for (const own of [".switch", '[role="switch"]', "[aria-expanded]", '[data-act="follow"]', "[data-feel-follow]", "[data-feel-own]", "[data-feel-sound]"]) {
    assert.equal(pointerPressSignal(0, node(["button", own])), null, own);
    const inside = node([], { tagName: "SPAN", parent: node(["button", own]) });
    assert.equal(pressableFrom(inside), null, `${own}, from a child`);
  }
});

test("Enter and Space press; a repeat, another key and a field do not", () => {
  const button = node(["button"]);
  assert.equal(keyPressSignal("Enter", false, button)?.kind, "tap");
  assert.equal(keyPressSignal(" ", false, button)?.kind, "tap");
  assert.equal(keyPressSignal("Enter", true, button), null, "a held key does not repeat the cue");
  assert.equal(keyPressSignal("Escape", false, button), null);
  assert.equal(keyPressSignal("a", false, button), null);
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.equal(keyPressSignal("Enter", false, node(["button"], { tagName })), null, tagName);
  }
});

test("a switch's own cue reads the state before the page flips it", () => {
  const on = node(["button", '[role="switch"]'], { attributes: { "aria-checked": "true" } });
  assert.deepEqual(ownSignal(on), { kind: "toggle", on: false }, "a checked switch is about to turn off");
  const off = node(["button", '[role="switch"]'], { attributes: { "aria-checked": "false" } });
  assert.deepEqual(ownSignal(off), { kind: "toggle", on: true });
  const unset = node(["button", '[role="switch"]']);
  assert.deepEqual(ownSignal(unset), { kind: "toggle", on: true });
});

test("the sound switch itself gets no toggle cue: turning it on is its own confirmation", () => {
  const sound = node(["button", '[role="switch"]', "[data-feel-sound]"], { attributes: { "aria-checked": "false" } });
  assert.equal(ownSignal(sound), null);
});

test("anything with aria-expanded glides open or shut", () => {
  const shut = node(["button", "[aria-expanded]"], { attributes: { "aria-expanded": "false" } });
  assert.deepEqual(ownSignal(shut), { kind: "expand" });
  const open = node(["button", "[aria-expanded]"], { attributes: { "aria-expanded": "true" } });
  assert.deepEqual(ownSignal(open), { kind: "collapse" });
  const disabled = node(["button", "[aria-expanded]"], { attributes: { "aria-expanded": "false" }, disabled: true });
  assert.equal(ownSignal(disabled), null);
  assert.equal(ownSignal(node(["button"])), null);
  assert.equal(ownSignal(null), null);
});

test("R3-12: a follow control rises to follow and falls to unfollow, by the state it is about to take; a disabled one is silent", () => {
  const notYet = node(["button", "[data-feel-follow]"], { attributes: { "aria-pressed": "false" } });
  assert.deepEqual(ownSignal(notYet), { kind: "follow", on: true });
  const following = node(["button", "[data-feel-follow]"], { attributes: { "aria-pressed": "true" } });
  assert.deepEqual(ownSignal(following), { kind: "follow", on: false });
  // From the label inside the button, as a real press lands.
  assert.deepEqual(ownSignal(node([], { tagName: "SPAN", parent: following })), { kind: "follow", on: false });
  assert.equal(ownSignal(node(["button", "[data-feel-follow]"], { attributes: { "aria-pressed": "false" }, disabled: true })), null);
  // Its press gets no tap on top: the follow phrase is its whole answer.
  assert.equal(pointerPressSignal(0, notYet), null);
  // The phrase itself: E5 to B5 to follow, G5 to C5 to unfollow, 140 ms each, 70 ms apart.
  assert.deepEqual(voicesFor({ kind: "follow", on: true }).map((voice) => [voice.hz, voice.durationMs, voice.atMs ?? 0]), [
    [659.25, 140, 0],
    [987.77, 140, 70],
  ]);
  assert.deepEqual(voicesFor({ kind: "follow", on: false }).map((voice) => [voice.hz, voice.durationMs, voice.atMs ?? 0]), [
    [783.99, 140, 0],
    [523.25, 140, 70],
  ]);
});

test("R3-12-AC-1: each of the ten pressable kinds answers with one tap; a switch, a disclosure and a follow answer with their own", () => {
  const pressable = ["a[href]", "button", "[data-act]", "[data-bx]", '[role="button"]', '[role="tab"]', '[role="option"]', '[role="menuitem"]', '[role="menuitemradio"]', "summary"];
  for (const selector of [...pressable, ".bx-card"]) {
    assert.deepEqual(pointerPressSignal(0, node([selector], { tagName: "DIV" })), { kind: "tap" }, selector);
    assert.deepEqual(keyPressSignal("Enter", false, node([selector], { tagName: "DIV" })), { kind: "tap" }, `${selector}, Enter`);
  }
  const own: readonly [readonly string[], Readonly<Record<string, string>>, unknown][] = [
    [["button", '[role="switch"]'], { "aria-checked": "false" }, { kind: "toggle", on: true }],
    [["button", "[aria-expanded]"], { "aria-expanded": "false" }, { kind: "expand" }],
    [["button", "[data-feel-follow]"], { "aria-pressed": "false" }, { kind: "follow", on: true }],
  ];
  for (const [selectors, attributes, signal] of own) {
    const control = node(selectors, { attributes });
    assert.equal(pointerPressSignal(0, control), null, `${selectors.join(" ")}: no tap`);
    assert.deepEqual(ownSignal(control), signal);
  }
});

test("R3-12-AC-4: a disabled control, a text input, a textarea and a select are silent", () => {
  assert.equal(pointerPressSignal(0, node(["button"], { disabled: true })), null);
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
    const field = node([tagName.toLowerCase()], { tagName });
    assert.equal(pointerPressSignal(0, field), null, tagName);
    assert.equal(keyPressSignal(" ", false, field), null, `${tagName}, Space`);
  }
});
