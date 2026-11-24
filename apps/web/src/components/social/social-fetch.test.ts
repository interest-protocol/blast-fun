import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { socialRequestAuth } from "./social-fetch.ts";

/** Social OA-16: one way for every social client to authenticate a call. */

test("OA-16: a Privy token is sent as Bearer; without one the wallet session cookie goes (same-origin); a failing source is null", async () => {
  assert.deepEqual(await socialRequestAuth(async () => "tok"), { headers: { authorization: "Bearer tok" }, credentials: "same-origin" });
  assert.deepEqual(await socialRequestAuth(async () => null), { headers: {}, credentials: "same-origin" });
  assert.deepEqual(await socialRequestAuth(undefined), { headers: {}, credentials: "same-origin" });
  assert.equal(await socialRequestAuth(async () => Promise.reject(new Error("privy down"))), null);
});

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const HELPER = "components/social/social-fetch.ts";

/** Every non-test `.ts`/`.tsx` source under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The code without its comments, so a doc comment may name the header it does not build. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** Browser code: the components and the pages (not the route handlers), and any module marked "use client". */
const isClient = (path: string, text: string) =>
  path.startsWith("components/") || (path.startsWith("app/") && !path.startsWith("app/api/")) || /^\s*["']use client["']/.test(text);

/** A client of a social route: it names one, or takes its paths and shapes from the social contracts. */
const isSocialClient = (text: string) => text.includes("/api/social") || /from\s+["'][^"']*modules\/social\/contracts\//.test(text);

/** An `Authorization` header written by hand: a `Bearer` value, or the header's name as a key or a `set`. */
const HAND_BUILT = [/\bBearer\b/, /["'`]?\bauthorization["'`]?\s*:/i, /\.(set|append)\(\s*["'`]authorization["'`]/i];

test("OA-16: no social client builds its own Authorization header; only social-fetch.ts writes the Bearer", () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of sources(SRC)) {
    const path = relative(SRC, file).split("\\").join("/");
    if (path === HELPER) continue;
    const text = readFileSync(file, "utf8");
    if (!isClient(path, text) || !isSocialClient(text)) continue;
    scanned += 1;
    const body = code(text);
    for (const pattern of HAND_BUILT) if (pattern.test(body)) offenders.push(`${path} (${pattern})`);
  }
  assert.ok(scanned > 40, `the scan found the social clients (${scanned})`);
  assert.deepEqual(offenders, [], "send the call through callSocialApi / socialRequestAuth (social-fetch.ts) instead");
  assert.match(readFileSync(join(SRC, HELPER), "utf8"), /authorization: `Bearer \$\{token\}`/, "the one place the header is built");
});
