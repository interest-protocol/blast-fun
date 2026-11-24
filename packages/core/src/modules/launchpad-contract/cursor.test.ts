import assert from "node:assert/strict";
import test from "node:test";

import {
  CursorError,
  EVENT_CURSOR,
  compareEventCursors,
  MAX_CURSOR_LENGTH,
  compareKeys,
  decodeCursor,
  encodeCursor,
  pageLimit,
  type CursorShape,
} from "./cursor.ts";

/** A projection's order: highest volume first, then newest launch, then launch id. */
const SHAPE: CursorShape = { scope: "launches:volume_24h", key: ["decimal", "integer"], tie: 1 };

test("a cursor round-trips its projection's key and tie-break, and is opaque", () => {
  const token = encodeCursor(SHAPE, ["1070151", 1_790_235_061_218], ["0xa1b2"]);
  assert.match(token, /^[A-Za-z0-9_-]+$/, "URL-safe base64, no padding");
  assert.deepEqual(decodeCursor(token, SHAPE), { key: ["1070151", 1_790_235_061_218], tie: ["0xa1b2"] });
});

test("tokens encode and decode without Node's Buffer, as a browser reads blast-infra's pages directly", () => {
  const shape: CursorShape = { scope: "coin_holders:0xa1", key: [], tie: 2 };
  const nodeToken = encodeCursor(shape, [], ["00000000000000000120", "Fröggy €"]);
  const buffer = globalThis.Buffer;
  try {
    Reflect.deleteProperty(globalThis, "Buffer");
    assert.equal(typeof (globalThis as { Buffer?: unknown }).Buffer, "undefined");
    const token = encodeCursor(shape, [], ["00000000000000000120", "Fröggy €"]);
    assert.equal(token, nodeToken, "the same opaque token as before");
    assert.deepEqual(decodeCursor(token, shape), { key: [], tie: ["00000000000000000120", "Fröggy €"] });
    assert.throws(() => decodeCursor("not-a-token", shape), CursorError);
  } finally {
    globalThis.Buffer = buffer;
  }
});

test("a cursor belongs to its scope, shape and version; anything else is an invalid cursor", () => {
  const token = encodeCursor(SHAPE, ["5", 7], ["0x1"]);
  const reject = (candidate: string, shape: CursorShape = SHAPE, why = candidate) =>
    assert.throws(() => decodeCursor(candidate, shape), CursorError, why);
  reject(token, { ...SHAPE, scope: "launches:created" });
  reject(token, { ...SHAPE, key: ["decimal"] });
  reject(token, { ...SHAPE, tie: 2 });
  const forged = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("base64url");
  reject(forged({ v: 2, s: SHAPE.scope, k: ["5", 7], t: ["0x1"] }));
  reject(forged({ v: 1, s: SHAPE.scope, k: [5, 7], t: ["0x1"] }), SHAPE, "a decimal key part is a string");
  reject(forged({ v: 1, s: SHAPE.scope, k: ["05", 7], t: ["0x1"] }));
  reject(forged({ v: 1, s: SHAPE.scope, k: ["5", 1.5], t: ["0x1"] }));
  reject(forged({ v: 1, s: SHAPE.scope, k: ["5", 7], t: [""] }), SHAPE, "tie-breaks are never empty");
  reject(forged({ v: 1, s: SHAPE.scope, k: ["5", 7], t: ["0x1"], x: 1 }));
  for (const bad of ["", "not base64!", "e30", "A".repeat(MAX_CURSOR_LENGTH + 1)]) reject(bad);
  assert.throws(() => encodeCursor(SHAPE, ["5", 7], []), CursorError, "a cursor names its tie-break");
});

test("keys compare numerically for decimal and integer parts, then by tie-break, deterministically", () => {
  const a = { key: ["9", 5], tie: ["0xb"] };
  const b = { key: ["10", 5], tie: ["0xa"] };
  assert.ok(compareKeys(SHAPE, a, b) < 0, "9 < 10, not as text");
  assert.ok(compareKeys(SHAPE, { key: ["10", 4], tie: ["0xz"] }, b) < 0);
  assert.ok(compareKeys(SHAPE, { key: ["10", 5], tie: ["0x9"] }, b) < 0, "the tie-break decides equal keys");
  assert.equal(compareKeys(SHAPE, b, { key: ["10", 5], tie: ["0xa"] }), 0);
});

test("limits clamp to their bounds like blast-infra's, and only digits are a limit", () => {
  const bounds = { default: 50, max: 100 };
  assert.equal(pageLimit(null, bounds), 50);
  assert.equal(pageLimit("0", bounds), 1);
  assert.equal(pageLimit("20", bounds), 20);
  assert.equal(pageLimit("0000000000000020", bounds), 20);
  assert.equal(pageLimit("0000000000000000", bounds), 1);
  assert.equal(pageLimit("1000", bounds), 100);
  assert.equal(pageLimit("18446744073709551616", bounds), 100);
  assert.equal(pageLimit("9".repeat(400), bounds), 100);
  assert.equal(pageLimit("1000000000000000", { default: 50, max: Number.MAX_SAFE_INTEGER }), 1_000_000_000_000_000);
  for (const bad of ["", "-1", "1.5", "+1", "ten", " 1"]) {
    assert.throws(() => pageLimit(bad, bounds), CursorError, bad);
  }
  assert.throws(() => pageLimit(null, { default: 0, max: 100 }), RangeError);
});

test("event cursors compare as numeric tuples", () => {
  assert.ok(compareEventCursors("9:0:0:0", "10:0:0:0") < 0);
  assert.ok(compareEventCursors("10:2:4294967295:0", "10:3:0:0") < 0);
  assert.equal(compareEventCursors("10:3:0:1", "10:3:0:1"), 0);
});

test("an event cursor is four canonical decimals of at most 20 digits", () => {
  assert.ok(EVENT_CURSOR.test("0:0:0:0"));
  assert.ok(EVENT_CURSOR.test("18446744073709551615:4294967295:12:1"));
  for (const bad of ["01:0:0:0", "1:0:0", "1:0:0:0:0", "123456789012345678901:0:0:0", "1:-1:0:0", "a:0:0:0"]) {
    assert.equal(EVENT_CURSOR.test(bad), false, bad);
  }
});
