import assert from "node:assert/strict";
import test from "node:test";

import { changeTone, STATUS_TONES, statusPresentation } from "./status.ts";

test("every semantic tone carries its own word and shape besides color", () => {
  const presented = STATUS_TONES.map(statusPresentation);
  assert.deepEqual(presented.map((tone) => tone.word), ["Up", "Down", "Unchanged", "Caution"]);
  assert.equal(new Set(presented.map((tone) => tone.glyph)).size, STATUS_TONES.length);
});

test("a change maps to up, down or unchanged, and an unknown change to no tone", () => {
  assert.equal(changeTone(0.426), "up");
  assert.equal(changeTone(-0.121), "down");
  assert.equal(changeTone(0), "flat");
  assert.equal(changeTone(-0), "flat");
  assert.equal(changeTone(Number.NaN), null);
  assert.equal(changeTone(null), null);
});
