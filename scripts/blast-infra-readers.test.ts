import assert from "node:assert/strict";
import test from "node:test";

/** The text of each call of `name(` in `source`, through its matching parenthesis. */
function calls(source: string, name: string): string[] {
  const found: string[] = [];
  for (let start = source.indexOf(`${name}(`); start >= 0; start = source.indexOf(`${name}(`, start + 1)) {
    if (/(?:function|\.)\s*$/.test(source.slice(Math.max(0, start - 10), start))) continue;
    let depth = 0;
    let end = start + name.length;
    for (; end < source.length; end += 1) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")" && --depth === 0) break;
    }
    found.push(source.slice(start, end + 1));
  }
  return found;
}

test("every server and worker reader of blast-infra is built on blastInfraFetch, so each request carries the key", async () => {
  const { existsSync, readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("../", import.meta.url).pathname;
  const packages = ["apps/web", "apps/workers", "apps/backend-api", "packages/core", "packages/server"];
  const files = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$|testing\.ts$|fixtures?\.ts$/.test(name) ? [path] : [];
    });
  const readers = ["createPresaleDiscovery", "createPresaleReadPath", "createPresaleTermsReader", "discoverPresales"];
  const sites: string[] = [];
  for (const file of packages.flatMap((pkg) => {
    const scripts = join(root, pkg, "scripts");
    return [...files(join(root, pkg, "src")), ...(existsSync(scripts) ? files(scripts) : [])];
  })) {
    const source = readFileSync(file, "utf8");
    for (const reader of readers) {
      for (const call of calls(source, reader)) {
        sites.push(`${file.slice(root.length)} ${reader}`);
        assert.match(call, /blastInfraFetch\(/, `${file.slice(root.length)}: ${call}`);
      }
    }
  }
  assert.deepEqual(sites.sort(), [
    "packages/server/src/modules/presale/receipts/runtime.ts createPresaleReadPath",
    "packages/server/src/modules/social/home/runtime.ts createPresaleTermsReader",
    "packages/server/src/modules/social/presales/shared-runtime.ts createPresaleTermsReader",
  ]);
  const capture = readFileSync(join(root, "apps/web/test/scripts/capture-v1-economics.ts"), "utf8");
  assert.match(capture, /blastInfraFetch\(\{ origin \}\)/);
  assert.doesNotMatch(capture, /await fetch\(/);
});
