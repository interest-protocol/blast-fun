import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * WP2: the browser never talks to blast-infra. Every module a client bundle
 * can hold (each `"use client"` file and everything it imports, transitively)
 * is read here, and none may name blast-infra's server-only configuration,
 * its key header, the server module that holds them, or open a WebSocket.
 */

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Core's sources, which web files import as `@blast/core/<path>.ts`; a client bundle holds them too. */
const CORE_SOURCE = resolve(SOURCE, "../../../packages/core/src");
/** The server package's sources: followed so a client import of `@blast/server/<path>.ts` is caught, never allowed. */
const SERVER_SOURCE = resolve(SOURCE, "../../../packages/server/src");
/** A file's path under its package's `src/`. */
const sourcePath = (file: string) => relative(file.startsWith(`${CORE_SOURCE}/`) ? CORE_SOURCE : file.startsWith(`${SERVER_SOURCE}/`) ? SERVER_SOURCE : SOURCE, file);
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** What no client module may contain, and why. */
const FORBIDDEN: readonly [RegExp, string][] = [
  [/BLAST_INFRA_API_KEY/, "blast-infra's server-only key"],
  [/BLAST_INFRA_ORIGIN/, "blast-infra's origin (server-only, or its deprecated public name)"],
  [/x-blast-infra-key/i, "the key header"],
  [/BLAST_INFRA_KEY_HEADER|blastInfraFetch|marketDataOrigin|defaultMarketDataDependencies/, "the server's blast-infra wiring"],
  [/new\s+WebSocket\b/, "a browser socket to private infra needs the server's key"],
];

/** The server module that holds the origin and key: no client module may reach it. */
const SERVER_ONLY = ["modules/read-routing/blast-infra.ts", "modules/social/activity/hint-runtime.ts"];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Whether the file's first statement, after any comments, is the `"use client"` directive. */
function isClientEntry(source: string): boolean {
  let rest = source.trimStart();
  for (;;) {
    if (rest.startsWith("//")) rest = rest.slice(rest.indexOf("\n") + 1 || rest.length).trimStart();
    else if (rest.startsWith("/*")) rest = rest.slice(rest.indexOf("*/") + 2 || rest.length).trimStart();
    else break;
  }
  return rest.startsWith('"use client"') || rest.startsWith("'use client'");
}

/** Alias prefixes and the source directories they name; the first match wins. */
const ALIASES: readonly [string, string][] = [
  ["#web/scripts/", join(SOURCE, "..", "scripts")],
  ["#web/", SOURCE],
  ["@blast/core/", CORE_SOURCE],
  ["@blast/server/", SERVER_SOURCE],
];

/** A project file an import specifier names, or null for a package. */
function resolveImport(specifier: string, from: string): string | null {
  const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix));
  const base = alias ? join(alias[1], specifier.slice(alias[0].length))
    : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (base === null) return null;
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The value imports of `source` (type-only imports are erased from bundles). */
function valueImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const [, typeOnly, specifier] of source.matchAll(/(?:^|\n)[ \t]*(?:import|export)\s+(type\s)?[^;"'()=]*?\bfrom\s*["']([^"']+)["']/g)) {
    if (!typeOnly) specifiers.push(specifier);
  }
  for (const [, specifier] of source.matchAll(/(?:^|\n)[ \t]*import\s*["']([^"']+)["']/g)) specifiers.push(specifier);
  for (const [, specifier] of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specifiers.push(specifier);
  return specifiers;
}

function clientGraph(): Map<string, string> {
  const reached = new Map<string, string>();
  const pending = sourceFiles(SOURCE).filter((file) => isClientEntry(readFileSync(file, "utf8")));
  assert.ok(pending.length > 50, "the walk finds the app's client components");
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (reached.has(file)) continue;
    const source = readFileSync(file, "utf8");
    reached.set(file, source);
    for (const specifier of valueImports(source)) {
      const target = resolveImport(specifier, file);
      if (target && !reached.has(target)) pending.push(target);
    }
  }
  return reached;
}

/** The reached files under packages/server/src: browser code shares only core and web modules. */
function serverReached(graph: ReadonlyMap<string, string>): string[] {
  return [...graph.keys()].filter((file) => file.startsWith(`${SERVER_SOURCE}/`)).map((file) => relative(SERVER_SOURCE, file));
}

test("WP2: no client module names blast-infra's server-only origin or key, reaches the server's blast-infra module, or opens a socket", () => {
  const graph = clientGraph();
  const files = [...graph.keys()].map(sourcePath);
  // The coin page's market reads are in the graph, through the same-origin client.
  for (const expected of ["components/launchpad/blast-infra-browser.ts", "components/launchpad/holders/CoinHolders.tsx", "modules/read-routing/market-data.ts"]) {
    assert.ok(files.includes(expected), `${expected} is client code`);
  }
  for (const serverOnly of SERVER_ONLY) assert.ok(!files.includes(serverOnly), `a client module reaches ${serverOnly}`);
  assert.deepEqual(serverReached(graph), [], "no client module reaches packages/server");
  const offences = [...graph].flatMap(([file, source]) =>
    FORBIDDEN.filter(([pattern]) => pattern.test(source)).map(([, why]) => `${sourcePath(file)}: ${why}`),
  );
  assert.deepEqual(offences, []);
});

test("the walk itself catches a client module that reaches the server's blast-infra module", () => {
  const imports = valueImports(`"use client";\nimport { useState } from "react";\nimport type { X } from "@blast/core/modules/read-routing/blast-infra.ts";\nimport { blastInfraFetch } from "@blast/core/modules/read-routing/blast-infra.ts";\n`);
  assert.deepEqual(imports, ["react", "@blast/core/modules/read-routing/blast-infra.ts"], "type-only imports are skipped, value imports are followed");
  assert.equal(resolveImport("@blast/core/modules/read-routing/blast-infra.ts", join(SOURCE, "components/x.tsx")), join(CORE_SOURCE, "modules/read-routing/blast-infra.ts"));
  assert.equal(resolveImport("#web/scripts/codemods/clsx-core.ts", join(SOURCE, "components/x.tsx")), join(SOURCE, "..", "scripts/codemods/clsx-core.ts"));
  const server = resolveImport("@blast/server/lib/site-origin.ts", join(SOURCE, "components/x.tsx"));
  assert.equal(server, join(SERVER_SOURCE, "lib/site-origin.ts"), "server specifiers resolve so the walk can flag them");
  assert.deepEqual(serverReached(new Map([[join(SOURCE, "components/x.tsx"), ""], [server!, ""]])), ["lib/site-origin.ts"]);
  assert.ok(isClientEntry(`// note\n"use client";\n`));
  assert.ok(!isClientEntry(`import "server-only";\n`));
});
