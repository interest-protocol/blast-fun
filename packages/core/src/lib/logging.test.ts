import assert from "node:assert/strict";
import test from "node:test";

import { createStructuredLog, type LogFields } from "./logging.ts";

test("Pino keeps metric fields, adds a level, and redacts secrets before JSON encoding", () => {
  const lines: string[] = [];
  const secret = 'secret-"line\n\\value';
  const log = createStructuredLog((line) => lines.push(line), [secret]);
  log("worker.pass", {
    job: "register",
    count: 2,
    ok: true,
    empty: null,
    message: `invalid ${secret} https://user:password@node suiprivkey1abcdef`,
    token: "access-token",
    password: "short",
    providerUrl: "https://node/?key=secret",
    metric: "forged",
    at: "forged",
    level: 100,
    error: new Error("must-not-serialize"),
    payload: { secret: "must-not-serialize" },
  } as unknown as LogFields);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.metric, "worker.pass");
  assert.equal(entry.level, 30);
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual([entry.job, entry.count, entry.ok, entry.empty], ["register", 2, true, null]);
  assert.equal(entry.message, "invalid [redacted] https://[redacted]@node [redacted]");
  assert.deepEqual([entry.token, entry.password, entry.providerUrl], Array(3).fill("[redacted]"));
  assert.equal(entry.error, undefined);
  assert.equal(entry.payload, undefined);
  assert.doesNotMatch(lines[0]!, /access-token|must-not-serialize|suiprivkey/);
});

test("browser imports write nothing", () => {
  const lines: string[] = [];
  const log = createStructuredLog((line) => lines.push(line));
  const scope = globalThis as { window?: unknown };
  scope.window = globalThis;
  try {
    log("worker.browser");
  } finally {
    delete scope.window;
  }
  assert.deepEqual(lines, []);
  log("worker.started");
  assert.equal(lines.length, 1);
});
