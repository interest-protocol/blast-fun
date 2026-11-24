import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FeelProvider } from "./FeelProvider.tsx";
import { FeelSoundButton, FeelSoundSwitch, FEEL_SETTINGS_ROW_DESCRIPTION, FEEL_SETTINGS_ROW_TITLE, FEEL_SETTINGS_SECTION_TITLE } from "./FeelSoundSwitch.tsx";
import { FEEL_SOUND_DEFAULT, FEEL_SOUND_KEY, readSoundEnabled, writeSoundEnabled } from "./feel-sound-pref.ts";

/**
 * OA-23 / FEEL-LAYER.md §6: what the layer puts in the server's HTML, and what
 * it must not. The non-negotiables it covers: the sound switch defaults to off
 * and persists; the provider renders nothing of its own, so there is no
 * hydration surface, no layout shift and no server/client divergence; and the
 * controls are reachable, labelled buttons that capture nothing.
 */

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    read: (key: string) => map.get(key) ?? null,
  };
}

test("the provider renders nothing of its own: no markup, no script, no layout shift", () => {
  assert.equal(renderToStaticMarkup(<FeelProvider>{null}</FeelProvider>), "");
  const wrapped = renderToStaticMarkup(
    <FeelProvider>
      <p>Home</p>
    </FeelProvider>,
  );
  assert.equal(wrapped, "<p>Home</p>", "the layer adds no wrapper, no overlay and no inline script");
});

test("no ball reaches the server's HTML: it only ever exists inside a gesture", () => {
  const html = renderToStaticMarkup(
    <FeelProvider>
      <button type="button">Blast</button>
    </FeelProvider>,
  );
  assert.doesNotMatch(html, /feel-ball|ball/i);
  assert.doesNotMatch(html, /aria-hidden/);
});

test("the Settings switch is off in the server's HTML, so hydration matches", () => {
  const html = renderToStaticMarkup(
    <FeelProvider>
      <FeelSoundSwitch />
    </FeelProvider>,
  );
  // Audio is opt-in: the gate defaults this on, the product does not (§6.1).
  assert.equal(FEEL_SOUND_DEFAULT, false);
  assert.match(html, /<button[^>]*role="switch"/);
  assert.match(html, /aria-checked="false"/);
  assert.match(html, /aria-label="Sound"/);
  assert.match(html, /type="button"/);
  assert.match(html, /data-feel-sound=""/, "the layer's own click rule skips it, so it gets one cue not two");
  assert.doesNotMatch(html, /aria-checked="true"/);
});

test("the Blast mode button is an off, labelled icon button with its 34 to 44 px class", () => {
  const html = renderToStaticMarkup(
    <FeelProvider>
      <FeelSoundButton />
    </FeelProvider>,
  );
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /aria-label="Sound"/);
  assert.match(html, /data-tip="Sound off"/);
  assert.match(html, /class="icon-btn soundButton"/, "the module's class carries the coarse-pointer size");
  // The glyph is decorative: the name is on the button.
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /tabindex/i, "nothing is taken out of the tab order or forced into it");
});

test("Settings' wording is the gate's, so the section does not get re-invented", () => {
  assert.equal(FEEL_SETTINGS_SECTION_TITLE, "Feel");
  assert.equal(FEEL_SETTINGS_ROW_TITLE, "Sound");
  assert.equal(FEEL_SETTINGS_ROW_DESCRIPTION, "Hear live buys and sells, taps and confirmations.");
});

test("the choice is stored under the gate's own key and read back; anything unreadable is off", () => {
  assert.equal(FEEL_SOUND_KEY, "blast.sound");
  const storage = memoryStorage();
  assert.equal(readSoundEnabled(storage), false, "no key means off");
  assert.equal(writeSoundEnabled(storage, true), true);
  assert.equal(storage.read(FEEL_SOUND_KEY), "true", "JSON, as the prototype writes it");
  assert.equal(readSoundEnabled(storage), true, "a device that used the prototype carries its choice over");
  assert.equal(writeSoundEnabled(storage, false), true);
  assert.equal(readSoundEnabled(storage), false);

  assert.equal(readSoundEnabled(memoryStorage({ [FEEL_SOUND_KEY]: "not json" })), false);
  assert.equal(readSoundEnabled(memoryStorage({ [FEEL_SOUND_KEY]: '"yes"' })), false, "a non-boolean is not a choice");
  assert.equal(readSoundEnabled(null), false, "no storage at all");
});

test("storage that refuses keeps the page working", () => {
  const refusing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readSoundEnabled(refusing), false);
  assert.equal(writeSoundEnabled(refusing, true), false, "the caller learns it was not remembered");
  assert.equal(writeSoundEnabled(null, true), false);
});
