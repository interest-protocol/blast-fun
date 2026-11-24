import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { qrMatrix } from "./qr";

/**
 * Social UI-14: the deposit QR code. The golden rows are the reference
 * encoder's (`qrcode`, level M, byte mode) for the design's sample wallet,
 * checked module for module when this encoder was written (every mask of
 * several inputs matched).
 */

const WALLET = "0x3f9a8c21d04b7e91a2c5f6e8b3d0794c1e2a5b6f8d9c0e1f2a3b4c5d6e7b1c21";
const GOLDEN = [
  "1fd9e30a7f", "10442e7841", "174ddc965d", "1759004b5d", "175e686b5d", "1050cb1141", "1fd555557f", "0014a19000", "11725310f9",
  "011dc6d716", "1450aaf296", "09913fe6c6", "176d88c544", "1cad35bab2", "0bdc3927b2", "0ebacc5506", "00cb844547", "012d933ab2",
  "07e5dd6290", "0aa98cc52e", "11c57e90ed", "0d87a96f18", "09c875ff88", "129f93b65e", "1febd300ec", "1b37067f12", "006ee2732e",
  "040c7b8687", "1edcc8c5f5", "0018b5bb16", "1fdbe83956", "104bac4317", "175c4655f7", "174e132849", "174b59bb44", "1049cce0ae",
  "1fd37e903f",
];

const rows = (matrix: boolean[][]) =>
  matrix.map((row) => BigInt(`0b${row.map((dark) => (dark ? "1" : "0")).join("")}`).toString(16).padStart(10, "0"));

test("a Sui address is a version-5 code, module for module the reference encoder's", () => {
  const matrix = qrMatrix(WALLET);
  assert.equal(matrix.length, 37);
  assert.deepEqual(rows(matrix), GOLDEN);
});

test("finder patterns sit in three corners; the size follows the data; too much data is refused", () => {
  for (const [text, size] of [["hi", 21], ["https://blast.fun/@kai", 25], [WALLET, 37], ["x".repeat(150), 49]] as const) {
    const matrix = qrMatrix(text);
    assert.equal(matrix.length, size, text.slice(0, 12));
    for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      assert.ok(matrix[y]![x] && matrix[y + 6]![x + 6] && !matrix[y + 1]![x + 1] && matrix[y + 3]![x + 3], `finder at ${x},${y}`);
    }
    // The dark module next to the bottom-left format bits.
    assert.equal(matrix[size - 8]![8], true);
  }
  assert.throws(() => qrMatrix("x".repeat(300)), RangeError);
});


test("all eight forced masks preserve the original deposit matrix", () => {
  const expected = [
    "c7407fbd7442457008458550e1e244ad8aa30890314803b63995b25f8de1fe4a",
    "41bbaa5aa157b8fed2ffa6b2421db951ffda02a3427ae2d13d152034d3796308",
    "87a0ce371c7a52c56e7db3736203bc995784cbbc3fd6391ce7059e2c14b0a901",
    "6f3b878d187e46ca96ccfadd9f5295c5865d0fdf1e8e28efabd6d6d6100d9920",
    "d383d761acfb2ee46c4193e3e3d9bc891b2a46e607742f5ae85ee1811efd18d2",
    "5560a3de4fd116cbe7ce6662528901c5763af9b2e0b77363ba2db66cc6c8c07e",
    "179d584843ce7088935bc7dc5f32fc5baa20bb844b54bf028f17be85ea96a328",
    "0db218fda058ff8fbe7ccd522004b97ea4eb33975daf28ba77e9a0225ad29d84"
];
  assert.deepEqual(Array.from({ length: 8 }, (_, mask) =>
    createHash("sha256").update(JSON.stringify(qrMatrix(WALLET, mask))).digest("hex")), expected);
});

test("the version-10 limit measures UTF-8 bytes, including empty and multibyte text", () => {
  assert.equal(qrMatrix("").length, 21);
  assert.equal(qrMatrix("x".repeat(213)).length, 57);
  assert.equal(qrMatrix("界".repeat(71)).length, 57);
  assert.throws(() => qrMatrix("x".repeat(214)), RangeError);
  assert.throws(() => qrMatrix("界".repeat(72)), RangeError);
});
