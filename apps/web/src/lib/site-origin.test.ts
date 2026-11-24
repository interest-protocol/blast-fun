import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeSiteOrigin } from "@blast/core/lib/site-origin.ts";
import { siteOrigin } from "@blast/server/lib/site-origin.ts";

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** An import or re-export of the server's runtime origin reader, static or dynamic. */
const SERVER_SITE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["']@blast\/server\/lib\/site-origin\.ts["']/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("Web owns its site origin as a literal NEXT_PUBLIC read, which Next inlines into every bundle", () => {
  const site = readFileSync(join(SOURCE, "lib/site.ts"), "utf8");
  assert.match(site, /export const SITE_ORIGIN = normalizeSiteOrigin\(process\.env\.NEXT_PUBLIC_SITE_URL\);/);
  const offenders = sourceFiles(SOURCE)
    // This test alone imports the server reader, to pin that both sides share one normalizer.
    .filter((file) => file !== fileURLToPath(import.meta.url) && SERVER_SITE_IMPORT.test(readFileSync(file, "utf8")))
    .map((file) => relative(SOURCE, file));
  assert.deepEqual(offenders, [], "Web imports SITE_ORIGIN from #web/lib/site.ts, never the server's runtime reader");
});

test("server and Web share one normalizer: production default and no trailing slashes", () => {
  assert.equal(normalizeSiteOrigin(undefined), "https://www.blast.fun");
  assert.equal(normalizeSiteOrigin("https://preview.test//"), "https://preview.test");
  assert.equal(siteOrigin({ NEXT_PUBLIC_SITE_URL: "https://x.test/" }), "https://x.test");
  assert.equal(siteOrigin({}), "https://www.blast.fun");
});

test("the import guard matches static and dynamic imports, not other mentions", () => {
  assert.ok(SERVER_SITE_IMPORT.test(`import { SITE_ORIGIN } from "@blast/server/lib/site-origin.ts";`));
  assert.ok(SERVER_SITE_IMPORT.test(`await import("@blast/server/lib/site-origin.ts")`));
  assert.ok(!SERVER_SITE_IMPORT.test(`resolveImport("@blast/server/lib/site-origin.ts", from)`));
});
