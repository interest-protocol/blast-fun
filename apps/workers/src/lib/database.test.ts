import assert from "node:assert/strict";
import test from "node:test";

import { DrizzleQueryError } from "drizzle-orm";

import { classifyFailure } from "#workers/modules/worker-runtime/record-keeper.ts";

const wrapped = (code: string) => new DrizzleQueryError("select $1", ["fixture"], Object.assign(new Error("database-fixture"), { code }));

test("ORM-wrapped outages are uncounted job retries", () => {
  for (const code of ["40001", "55P03", "53300", "08006", "ECONNRESET"]) {
    assert.deepEqual(classifyFailure(wrapped(code)), { outcome: "retry", errorClass: "database-unavailable" });
  }
});

test("an ORM-wrapped constraint violation is a counted local failure", () => {
  assert.deepEqual(classifyFailure(wrapped("23505")), { outcome: "retry", errorClass: "internal-error", counted: true });
});
