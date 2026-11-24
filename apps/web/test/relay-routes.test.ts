import assert from "node:assert/strict";
import test from "node:test";
import { relayDrift } from "#web/scripts/generate-relay-routes.ts";

test("every relay route file is exactly what the route tables generate", () => {
  assert.deepEqual(relayDrift(), []);
});
