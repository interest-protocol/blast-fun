import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("integration runner reports every file when a child cannot start", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("./test-integration.mjs", import.meta.url)),
    "src/lib/web-security/web-security.integration.test.ts",
    "src/components/social/blast-mode/workspace/PresalesData.integration.test.ts",
  ], {
    cwd: fileURLToPath(new URL("../apps/web", import.meta.url)),
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /2 files, 2 failed/);
  assert.match(result.stdout, /spawn bash ENOENT/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
});

const FILE = "src/components/social/blast-mode/workspace/PresalesData.integration.test.ts";

// Runs the runner on FILE with a fake bash that prints `output` and exits 0.
function runWithOutput(output) {
  const bin = mkdtempSync(join(tmpdir(), "fake-bash-"));
  writeFileSync(join(bin, "bash"), `#!/bin/sh\nprintf '%b\\n' ${JSON.stringify(output.replaceAll("\x1b", "\\033"))}\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./test-integration.mjs", import.meta.url)), FILE], {
    cwd: fileURLToPath(new URL("../apps/web", import.meta.url)),
    env: { ...process.env, PATH: bin },
    encoding: "utf8",
  });
  rmSync(bin, { recursive: true });
  return result;
}

const NODE_EMPTY = `✔ ${FILE} (82.3ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0`;

for (const [runner, summary, note] of [
  ["node", "ℹ tests 2\nℹ pass 1\nℹ skipped 1\nℹ todo 0\nℹ fail 0", "1 skipped"],
  ["colored node", "\x1b[34mℹ tests 2\x1b[39m\n\x1b[34mℹ skipped 1\x1b[39m", "1 skipped"],
  ["node", "ℹ tests 2\nℹ pass 1\nℹ skipped 0\nℹ todo 1", "1 todo"],
  ["node (a file with no test() calls)", NODE_EMPTY, "no tests ran"],
  ["node (a logged summary before the real one)", "ℹ skipped 0\nℹ tests 3\nℹ pass 1\nℹ skipped 2\nℹ todo 0", "2 skipped"],
  ["bun", " 1 pass\n 1 skip\n 0 fail\nRan 2 tests across 1 file.", "1 skipped"],
  ["colored bun", "\x1b[32m 1 pass\x1b[0m\n\x1b[33m 1 skip\x1b[0m\n 0 fail\nRan 2 tests across 1 file.", "1 skipped"],
  ["bun", " 1 pass\n 1 todo\n 0 fail\nRan 2 tests across 1 file.", "1 todo"],
  ["bun", " 0 pass\n 0 fail\nRan 0 tests across 1 file.", "no tests ran"],
  ["wrapper (no test summary)", "database ready", "no tests ran"],
]) {
  test(`integration runner fails a file whose ${runner} run reports ${note}`, () => {
    const result = runWithOutput(summary);
    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(`FAIL .*PresalesData\\.integration\\.test\\.ts \\(${note}\\)`));
    assert.match(result.stdout, /1 files, 1 failed/);
  });
}

for (const [runner, summary] of [
  ["node", "ℹ tests 2\nℹ pass 2\nℹ skipped 0\nℹ todo 0"],
  ["node (one test, a logged count before the summary)", "rows skipped 3\n 7 skip\n✔ one (1ms)\nℹ tests 1\nℹ pass 1\nℹ skipped 0\nℹ todo 0"],
  ["bun", " 2 pass\n 0 fail\nRan 2 tests across 1 file."],
]) {
  test(`integration runner passes a file whose ${runner} run reports every test run`, () => {
    const result = runWithOutput(summary);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /1 files, 0 failed/);
  });
}
