import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FeelProvider } from "./FeelProvider.tsx";
import { FEEL_SOUND_KEY, readSoundEnabled, writeSoundEnabled } from "./feel-sound-pref.ts";

/**
 * OA-23 / FEEL-LAYER.md §6: what the layer puts in the server's HTML, and what
 * it must not. The non-negotiables it covers: sound defaults to on
 * and persists; the provider renders nothing of its own, so there is no
 * hydration surface, no layout shift and no server/client divergence; and the
 * preference survives a reload.
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

test("the choice is stored under the gate's own key and read back; anything unreadable uses the on default", () => {
  assert.equal(FEEL_SOUND_KEY, "blast.sound");
  const storage = memoryStorage();
  assert.equal(readSoundEnabled(storage), true, "no key means on");
  assert.equal(writeSoundEnabled(storage, true), true);
  assert.equal(storage.read(FEEL_SOUND_KEY), "true", "JSON, as the prototype writes it");
  assert.equal(readSoundEnabled(storage), true, "a device that used the prototype carries its choice over");
  assert.equal(writeSoundEnabled(storage, false), true);
  assert.equal(readSoundEnabled(storage), false);

  assert.equal(readSoundEnabled(memoryStorage({ [FEEL_SOUND_KEY]: "not json" })), true);
  assert.equal(readSoundEnabled(memoryStorage({ [FEEL_SOUND_KEY]: '"yes"' })), true, "a non-boolean is not a choice");
  assert.equal(readSoundEnabled(null), true, "no storage at all");
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
  assert.equal(readSoundEnabled(refusing), true);
  assert.equal(writeSoundEnabled(refusing, true), false, "the caller learns it was not remembered");
  assert.equal(writeSoundEnabled(null, true), false);
});
