import assert from "node:assert/strict";
import test from "node:test";
import { assertImageStartup } from "./backend-image-contract.mjs";

const expected =
  "error: BLAST_REDIS_NAMESPACE must identify the network, deployment and environment.";
const bun = "Bun v1.4.2 (Linux x64)";

test("production image gate accepts only the pinned Bun configuration refusal", () => {
  assert.doesNotThrow(() =>
    assertImageStartup(
      1,
      `${expected}\n    at backendConfig (config.ts:18:11)\n\n${bun}\n`,
    ),
  );
  for (const [status, output] of [
    [0, expected],
    [125, expected],
    [null, expected],
    [1, ""],
    [1, "error: Cannot find package 'pg'"],
    [1, `${expected}\nerror: unrelated startup failure\n${bun}`],
    [1, `${expected}\n{"level":30,"role":"api","metric":"backend.listening"}\n${bun}`],
    [1, `${expected}\nBun v1.4.1 (Linux x64)`],
    [
      1,
      `Error: BLAST_REDIS_NAMESPACE must identify the network, deployment and environment.\nNode.js v24.18.0`,
    ],
  ]) {
    assert.throws(() => assertImageStartup(status, output));
  }
});
