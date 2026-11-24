import assert from "node:assert/strict";
import { primaryPool, replicaPool } from "@blast/core/modules/database/pool.ts";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";

import { endProcessPools } from "../../../../../../packages/core/test/fixtures/modules/database/testing.ts";
import { SOCIAL_PROFILE_ITEMS_ROUTE, SOCIAL_PROFILE_ROUTE } from "@blast/core/modules/social/contracts/profiles.ts";
import { profileCallsignParameter } from "@blast/server/modules/social/profiles/route.ts";

/**
 * Social-feed T-018-AC-3 (AC-165): the production profile routes and the
 * `/crew/<callsign>` page read through the replica pool, never the primary,
 * and fail closed without a replica. Also the routes' path parsing.
 */

// `server-only` is a bundler marker with no Node entry; outside Next it is empty.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});

const PRIMARY = "postgresql://app:app-secret@127.0.0.1:9/never_connected";
const REPLICA = "postgresql://reader:reader-secret@127.0.0.1:9/never_connected?application_name=replica";

function withEnvironment(t: TestContext, values: Record<string, string | undefined>): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(async () => {
    await endProcessPools();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("T-018-AC-3 (AC-165): profile reads take the replica pool, not the primary", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: REPLICA });
  const { socialProfilePool } = await import("@blast/server/modules/social/profiles/runtime.ts");
  const replica = socialProfilePool();
  assert.equal(replica, replicaPool());
  assert.notEqual(replica, primaryPool());
  assert.equal(replica.options.connectionString, REPLICA);

  // The routes read through socialProfileDatabase, which is that pool.
  const source = await readFile(new URL(import.meta.resolve("@blast/server/modules/social/profiles/runtime.ts")), "utf8");
  assert.match(source, /autocommitReader\(socialProfilePool\(\), "social"/);
  assert.match(source, /database: socialProfileDatabase/);
  assert.doesNotMatch(source, /primaryPool|databaseFor\(/);
  const page = await readFile(new URL("../../../app/(app)/(social)/crew/[callsign]/page.tsx", import.meta.url), "utf8");
  // UI-06: the page and its right column share the reads through `profile-reads.ts` (once per request).
  const reads = await readFile(new URL("../../../app/(app)/(social)/crew/[callsign]/profile-reads.ts", import.meta.url), "utf8");
  assert.match(page, /from "\.\/profile-reads"/);
  assert.match(reads, /from "#web\/lib\/backend-api\/social-reads\.ts"/);
  assert.doesNotMatch(reads, /Pool|databaseFor|autocommitReader/);
  assert.doesNotMatch(page, /Pool|databaseFor|autocommitReader/);
});

test("T-018-AC-3 (AC-165): without a replica profiles fail closed instead of reading the primary", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: undefined });
  const { socialProfileDatabase } = await import("@blast/server/modules/social/profiles/runtime.ts");
  assert.throws(() => socialProfileDatabase(), /DATABASE_REPLICA_URL is required/);
});

test("T-018: profile routes take one callsign segment, decoded once", () => {
  assert.equal(SOCIAL_PROFILE_ROUTE, "GET /api/social/profiles/{callsign}");
  assert.equal(SOCIAL_PROFILE_ITEMS_ROUTE, "GET /api/social/profiles/{callsign}/items");
  const at = (path: string) => new Request(`https://blast.fun/api/social/profiles/${path}`);
  assert.equal(profileCallsignParameter(at("kai"), ""), "kai");
  assert.equal(profileCallsignParameter(at("late_one"), ""), "late_one");
  assert.equal(profileCallsignParameter(at("ka%69"), ""), "kai");
  assert.equal(profileCallsignParameter(at("kai/items"), "/items"), "kai");
  for (const [path, suffix] of [
    ["kai/items", ""], ["kai", "/items"], ["Kai", ""], ["k", ""], ["kai%2Fnova", ""], ["%E0%A4%A", ""], ["", ""],
    ["/items", "/items"], ["kai/x/items", "/items"], ["kai%2569", ""], [`0x${"a".repeat(64)}`, ""],
  ] as const) {
    assert.throws(
      () => profileCallsignParameter(at(path), suffix),
      (error: { code?: string; extra?: { parameter?: string } }) => error.code === "invalid_parameter" && error.extra?.parameter === "callsign",
      `${path} ${suffix}`,
    );
  }
});
