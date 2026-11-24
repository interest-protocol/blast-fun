import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The presale deployment stays on the server. Its identity is the server's
 * `PRESALE_DEPLOYMENT_MANIFEST` (and `BLAST_PRESALE_*`), which no browser
 * bundle carries, so browser code that reads it (`readPresaleDeploymentIdentity`
 * in `modules/presale/deployment/service.ts`) always sees "not deployed": the
 * commit used to be built that way in the browser and could never be signed.
 * The commit is now built by `POST /api/social/me/commits`, as the claim is by
 * its route, and the browser only signs. This guard keeps it that way:
 *
 * 1. no client module under `src/components` imports
 *    `modules/presale/deployment` (a server component — `server-only` or
 *    `next/headers` — may, and passes the result down as a prop, as the
 *    layouts pass `presaleDeployed`);
 * 2. nothing a `"use client"` module reaches through its value imports —
 *    static, dynamic (`import()`) or re-exported, transitively — is a file of
 *    `modules/presale/deployment`. Type-only imports are erased and do not
 *    count.
 *
 * The same shape as `social-fetch.test.ts`'s OA-16 guard: a scan of the
 * source tree, comments stripped, with a sanity floor on what it scanned.
 */

const SRC = fileURLToPath(new URL("../../", import.meta.url));
/** Core's sources, which web files import as `@blast/core/<path>.ts`; the presale deployment is there. */
const CORE_SRC = fileURLToPath(new URL("../../../../../packages/core/src/", import.meta.url));
const DEPLOYMENT = "modules/presale/deployment/";

/** Every non-test `.ts`/`.tsx` source under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The code without its comments, so a doc comment may name what it does not import. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** A file's path under its package's `src/`. */
const pathOf = (file: string) => relative(file.startsWith(CORE_SRC) ? CORE_SRC : SRC, file).split("\\").join("/");

/** A module the bundler keeps on the server: it says so (`server-only`), or reads the request (`next/headers`). */
const isServerModule = (text: string) => /^\s*import\s+["']server-only["']/m.test(text) || /from\s+["']next\/headers["']/.test(text);
const isUseClient = (text: string) => /^\s*["']use client["']/.test(code(text));

/** Every specifier `text` imports for its value: static and side-effect imports, `export … from`, and `import()`. */
function valueImports(text: string): string[] {
  const body = code(text);
  const found: string[] = [];
  // A clause is names, braces, `* as`, commas and space: never `=` or `;`, so one statement never runs into the next.
  const statement = /\b(import|export)\s+(type\s+)?([\w$*{}\s,]+?)\s*from\s*["']([^"']+)["']/g;
  for (const match of body.matchAll(statement)) {
    const [, , typeOnly, clause = "", specifier = ""] = match;
    if (typeOnly) continue;
    // `import { type A, type B } from` is erased too; a default or namespace import, or any plain name, is not.
    const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
    if (named) {
      const names = named[1]!.split(",").map((name) => name.trim()).filter(Boolean);
      if (names.length > 0 && names.every((name) => /^type\s/.test(name))) continue;
    }
    found.push(specifier);
  }
  for (const match of body.matchAll(/(?:^|[;\s])import\s*["']([^"']+)["']/g)) found.push(match[1]!);
  for (const match of body.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]!);
  return found;
}

/** A project file a specifier names (`#web/…`, `@blast/core/…` or relative), or null for a package. */
function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith("#web/scripts/") ? join(SRC, "..", "scripts", specifier.slice("#web/scripts/".length))
    : specifier.startsWith("#web/") ? join(SRC, specifier.slice("#web/".length))
    : specifier.startsWith("@blast/core/") ? join(CORE_SRC, specifier.slice("@blast/core/".length))
    : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const namesDeployment = (specifier: string) => /(^|\/)modules\/presale\/deployment(\/|\.ts$|$)/.test(specifier) || /(^|\/)presale\/deployment(\/|$)/.test(specifier);

test("the guard reads value imports, and leaves type-only ones out", () => {
  assert.equal(resolveImport(join(SRC, "components/x.tsx"), "#web/scripts/codemods/clsx-core.ts"), join(SRC, "..", "scripts/codemods/clsx-core.ts"));
  const sample = [
    'import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";',
    'import { type PresaleDeploymentState } from "../../presale/deployment/contracts.ts";',
    'import { readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";',
    'import { mainnetIdentity, type CommitChain } from "./chain.ts";',
    'export { presaleNode } from "./node.ts";',
    'export type { ChainIdentifierNode } from "./contracts.ts";',
    'export * as presale from "./presale.ts";',
    'export type Shape = { a: string };',
    'import "server-only";',
    'const { runCommitFor } = await import("./commit-run");',
    "// import { nothing } from \"./commented.ts\";",
  ].join("\n");
  assert.deepEqual(valueImports(sample), [
    "@blast/core/modules/presale/deployment/service.ts",
    "./chain.ts",
    "./node.ts",
    "./presale.ts",
    "server-only",
    "./commit-run",
  ]);
  assert.ok(namesDeployment("@blast/core/modules/presale/deployment/service.ts"));
  assert.ok(namesDeployment("../../presale/deployment/runtime.ts"));
  assert.ok(namesDeployment("#web/modules/presale/deployment/release-check.ts"));
  assert.ok(!namesDeployment("@blast/server/modules/sponsor/policy.ts"));
});

test("the shell reads the presale deployment on the server and no client component imports it", () => {
  const offenders: string[] = [];
  const servers: string[] = [];
  let scanned = 0;
  for (const file of [...sources(join(SRC, "components")), join(SRC, "app/(app)/layout.tsx")]) {
    const text = readFileSync(file, "utf8");
    const imports = valueImports(text).filter(namesDeployment);
    if (isServerModule(text)) {
      if (imports.length > 0) servers.push(pathOf(file));
      continue;
    }
    scanned += 1;
    for (const specifier of imports) offenders.push(`${pathOf(file)} imports ${specifier}`);
  }
  assert.ok(scanned > 200, `the scan found the client modules (${scanned})`);
  assert.deepEqual(offenders, [], "build presale transactions on the server (POST /api/social/me/commits, the claim route) and sign in the browser");
  // The server components that read it, by name: each reads the manifest on the server and passes `presaleDeployed` down.
  assert.deepEqual(servers, ["app/(app)/layout.tsx"]);
  // The commit's browser half, by name: it asks the server and imports nothing of the deployment or the SDK's builder.
  for (const file of ["commit/commit-run.ts", "commit/commit-flow.ts", "commit/CommitHost.tsx", "commit/commit-client.ts"]) {
    const text = code(readFileSync(join(SRC, "components/social", file), "utf8"));
    assert.doesNotMatch(text, /readPresaleDeploymentIdentity|presaleDeploymentGate|PRESALE_DEPLOYMENT_MANIFEST|modules\/social\/commit\/chain/, file);
  }
});

test("nothing a \"use client\" module reaches through its value imports is a file of the presale deployment", () => {
  const all = sources(SRC);
  const entries = all.filter((file) => isUseClient(readFileSync(file, "utf8")));
  assert.ok(entries.length > 100, `the scan found the "use client" modules (${entries.length})`);
  const seen = new Map<string, string>();
  const queue = entries.map((file) => ({ file, via: pathOf(file) }));
  const reached: string[] = [];
  while (queue.length > 0) {
    const { file, via } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.set(file, via);
    if (pathOf(file).startsWith(DEPLOYMENT)) {
      reached.push(via);
      continue;
    }
    for (const specifier of valueImports(readFileSync(file, "utf8"))) {
      const next = resolveImport(file, specifier);
      if (next && !seen.has(next)) queue.push({ file: next, via: `${via} → ${pathOf(next)}` });
    }
  }
  assert.ok(seen.size > entries.length, `the walk followed imports (${seen.size} modules)`);
  // The commit's browser half is in the walk (CommitHost imports commit-run dynamically).
  assert.ok(seen.has(join(SRC, "components/social/commit/commit-run.ts")), "the dynamic import of commit-run is followed");
  assert.deepEqual(reached, [], "a client module reaches the presale deployment; read it on the server and pass the result down");
});
