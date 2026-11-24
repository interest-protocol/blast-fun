import assert from "node:assert/strict";
import test from "node:test";

import { parseProcStat } from "./proc-stat.mjs";

test("process accounting accepts command names containing spaces and closing parentheses", () => {
  assert.deepEqual(parseProcStat("123 (worker ) with space) S 42 0 0 0 0 0 0 0 0 0 12 3 0"), { parent: 42, cpu: 15 });
});

test("malformed or truncated process records cannot produce invalid resource counters", () => {
  for (const text of ["", "123 worker S 42", "123 (worker) S 42", "123 (worker) S -1 0 0 0 0 0 0 0 0 0 12 3", "123 (worker) S 42 0 0 0 0 0 0 0 0 0 bad 3"]) {
    assert.throws(() => parseProcStat(text), /Invalid process stat/);
  }
});
