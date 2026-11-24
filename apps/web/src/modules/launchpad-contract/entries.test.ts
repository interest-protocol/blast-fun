import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { browserBundle } from "#web/test/browser-bundle.ts";

const core = new URL("../../../../../packages/core/src/", import.meta.url);
const entries = [
  new URL("browser-holders.ts", import.meta.url),
  new URL("browser-rewards.ts", import.meta.url),
  ...["venue-history", "activity"].map(
    (name) => new URL(`modules/launchpad-contract/${name}.ts`, core),
  ),
  ...["wire", "read-path", "web-api", "errors", "routes"].map(
    (name) => new URL(`modules/presale/contracts/${name}.ts`, core),
  ),
];

test("browser read clients and published presale contracts bundle without server capabilities", async () => {
  const bundles = await browserBundle(entries.map((entry) => fileURLToPath(entry)));
  const modules = (Array.isArray(bundles) ? bundles : [bundles]).flatMap((bundle) =>
    "output" in bundle
      ? bundle.output.flatMap((output) =>
          output.type === "chunk" ? Object.keys(output.modules) : [],
        )
      : [],
  );
  assert.ok(
    modules.some((id) => id.endsWith("/lib/logging.browser.ts")),
    "package imports select the browser metric sink",
  );
  assert.ok(
    !modules.some((id) => id.endsWith("/lib/logging.ts")),
    "the backend log drain stays out of the browser",
  );
});

async function bundleProbe(source: string, helper = "export const answer = 42;\n") {
  const directory = mkdtempSync(
    fileURLToPath(new URL("../../../test/.browser-boundary-", import.meta.url)),
  );
  try {
    writeFileSync(join(directory, "entry.ts"), source);
    writeFileSync(join(directory, "helper.ts"), helper);
    return await browserBundle(join(directory, "entry.ts"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("browser resolution accepts helper extraction, lazy browser imports and erased server types", async () => {
  await bundleProbe(`
    import type { Stats } from 'node:fs';
    export type FileStats = Stats;
    export { answer } from './helper.ts';
    export const load = () => import('./helper.ts');
  `);
});

test("browser resolution rejects static, re-exported and lazy Node capabilities", async () => {
  for (const source of [
    "import 'node:fs';",
    "export { readFileSync } from 'fs';",
    "export const load = () => import('node:fs');",
    "export const load = () => require('node:fs');",
  ]) {
    await assert.rejects(bundleProbe(source), /Browser dependency cannot load (node:)?fs/);
  }
});

test("browser resolution checks dependencies behind an extracted helper", async () => {
  await assert.rejects(
    bundleProbe(
      "export { answer } from './helper.ts';",
      "import 'node:fs'; export const answer = 42;",
    ),
    /Browser dependency cannot load node:fs/,
  );
});

test("browser resolution rejects server modules and respects blocked package exports", async () => {
  for (const specifier of [
    "server-only",
    "@blast/server/config/runtime-config.ts",
    "#web/lib/server-config.ts",
    "@blast/core/modules/database/pool.ts",
  ]) {
    await assert.rejects(
      bundleProbe(`import ${JSON.stringify(specifier)};`),
      /Browser dependency cannot load/,
    );
  }
  await assert.rejects(
    bundleProbe('import "@blast/core/modules/social/contracts/validate.ts";'),
    /(?:exports|specifier|resolve)/i,
  );
});

test("browser resolution rejects dependencies it cannot resolve at build time", async () => {
  for (const source of [
    "export const load = (path: string) => import(path);",
    "export const load = (path: string) => require(path);",
  ]) {
    await assert.rejects(bundleProbe(source), /Unresolved browser dependency/);
  }
});
