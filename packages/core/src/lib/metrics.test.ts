import assert from "node:assert/strict";
import test from "node:test";

import { recordMetric } from "./metrics.ts";

test("metrics are written on the server and never to a visitor's browser console", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  recordMetric("read.degraded", { resource: "market", outcome: "unavailable" });
  assert.equal(lines.length, 1, "the server writes its metric line");

  const scope = globalThis as { window?: unknown };
  scope.window = globalThis;
  try {
    recordMetric("read.degraded", { resource: "market", outcome: "unavailable" });
  } finally {
    delete scope.window;
  }
  assert.equal(lines.length, 1, "a browser writes nothing: no log drain collects it");
});
