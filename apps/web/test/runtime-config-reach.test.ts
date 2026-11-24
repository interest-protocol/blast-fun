import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";

/**
 * `runtimeConfig()` parses the API's full environment. Web functions, Render worker processes and worker threads
 * (spawned with `env: {}`) have no such environment, and web scripts pass their inputs, so none
 * may import it at all.
 * Each check walks the real import closure, resolved as the compiler resolves it.
 */

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const runtimeConfig = join(repositoryRoot, "packages/server/src/config/runtime-config.ts");
const { options } = ts.getParsedCommandLineOfConfigFile(
  join(repositoryRoot, "apps/web/tsconfig.json"),
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
)!;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(path);
    }
    return /\.(tsx?|mjs)$/.test(entry.name) && !/\.test\.|\.d\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** One import chain from an entry to `target`, as repository paths, or null when none exists. */
function pathTo(entries: readonly string[], target: string): string[] | null {
  const parent = new Map<string, string | null>(entries.map((entry) => [entry, null]));
  const queue = [...entries];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (file === target) {
      const chain = [];
      for (let step: string | null = file; step !== null; step = parent.get(step)!) {
        chain.unshift(relative(repositoryRoot, step));
      }
      return chain;
    }
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName } of importedFiles) {
      const resolved = ts.resolveModuleName(fileName, file, options, ts.sys).resolvedModule?.resolvedFileName;
      if (resolved && !resolved.includes("/node_modules/") && !parent.has(resolved)) {
        parent.set(resolved, file);
        queue.push(resolved);
      }
    }
  }
  return null;
}

test("no web source or web script reaches the API runtime config", () => {
  const entries = ["apps/web/src", "apps/web/scripts"].flatMap((root) => sourceFiles(join(repositoryRoot, root)));

  assert.equal(pathTo(entries, runtimeConfig), null);
});

// This fails if web stops reading its settings through webConfig() and the
// relay config, which would also let the check above pass on a closure that
// no longer holds web's settings at all.
test("web reaches its own settings, webConfig() and the relay config, from the proxy", () => {
  const proxy = [join(repositoryRoot, "apps/web/src/proxy.ts")];

  assert.notEqual(pathTo(proxy, join(repositoryRoot, "apps/web/src/lib/server-config.ts")), null);
  assert.notEqual(pathTo(proxy, join(repositoryRoot, "packages/server/src/private/relay-config.ts")), null);
});

test("no worker thread reaches the API runtime config", () => {
  const spawn = /new Worker\(\s*new URL\(\s*"([^"]+)",\s*import\.meta\.url/g;
  const entries = ["apps/web/src", "apps/backend-api/src", "apps/workers/src", "packages/server/src", "packages/core/src"]
    .flatMap((root) => sourceFiles(join(repositoryRoot, root)))
    .flatMap((file) => [...readFileSync(file, "utf8").matchAll(spawn)].map((match) => fileURLToPath(new URL(match[1]!, `file://${file}`))));

  assert.ok(entries.length >= 4, `found only ${entries.length} worker entries`);
  for (const entry of entries) {
    assert.equal(pathTo([entry], runtimeConfig), null, relative(repositoryRoot, entry));
  }
});

test("no Render worker process reaches the API runtime config", () => {
  const workers = join(repositoryRoot, "apps/workers");
  const entry = [join(workers, "scripts/worker.ts")];

  // The walk must follow the process table's lazy imports, or the check below passes on nothing.
  assert.notEqual(pathTo(entry, join(workers, "src/modules/blast-keeper-worker/main.ts")), null);
  assert.notEqual(pathTo(entry, join(workers, "src/modules/social/worker/main.ts")), null);
  assert.equal(pathTo(entry, runtimeConfig), null);
});

test("the hints entry never reaches the API runtime config; the API entry does", () => {
  const entry = (path: string) => [join(repositoryRoot, path)];

  assert.equal(pathTo(entry("apps/backend-api/src/hints-main.ts"), runtimeConfig), null);
  assert.notEqual(pathTo(entry("apps/backend-api/src/main.ts"), runtimeConfig), null);
});
