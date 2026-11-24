import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * R3-12-AC-10: the Feel layer writes nothing onto `window`, wraps no global
 * function, and ships no audio file: every sound is generated (Web Audio), and
 * every cue is called where its action happens. Checked over the layer's own
 * sources, as the criterion's grep; the `package.json` and `public/` halves
 * are checked on the branch's diff.
 */

const HERE = new URL("./", import.meta.url);

async function sources(): Promise<readonly Readonly<{ name: string; text: string }>[]> {
  const names = (await readdir(HERE)).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name));
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(new URL(name, HERE), "utf8") })));
}

test("R3-12-AC-10: no window assignment, no wrapped global, no exported feelSound", async () => {
  const files = await sources();
  assert.ok(files.length >= 10, "the layer's sources were read");
  for (const { name, text } of files) {
    assert.doesNotMatch(text, /\bwindow\.[A-Za-z_$][\w$]*\s*=(?!=)/, `${name} assigns onto window`);
    assert.doesNotMatch(text, /\bwindow\[[^\]]+\]\s*=(?!=)/, `${name} wraps a global by name`);
    assert.doesNotMatch(text, /feelSound/, `${name} exports the lab's feelSound`);
  }
});

test("R3-12-AC-10: no audio file is fetched or imported; the voice is an oscillator", async () => {
  const files = await sources();
  for (const { name, text } of files) {
    assert.doesNotMatch(text, /\.(mp3|wav|ogg|m4a|aac|flac|webm)\b/i, `${name} names an audio file`);
    assert.doesNotMatch(text, /new Audio\(|decodeAudioData|HTMLAudioElement/, `${name} plays recorded audio`);
  }
  const synth = files.find((file) => file.name === "feel-synth.ts");
  assert.match(synth?.text ?? "", /createOscillator\(\)/);
});
