import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

test("shared response schema changes require an explicit v1 compatibility review", () => {
  const root = new URL("../../../../../../", import.meta.url);
  const baseline: Record<string, string> = JSON.parse(readFileSync(new URL("./contract-baseline.json", import.meta.url), "utf8"));
  for (const [path, expected] of Object.entries(baseline)) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex"), expected,
      `${path}: preserve the v1 contract with an adapter or create v2. Only reviewed additive changes may update this baseline.`);
  }
});
