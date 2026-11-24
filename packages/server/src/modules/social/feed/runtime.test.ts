import assert from "node:assert/strict";
import { primaryPool, replicaPool } from "@blast/core/modules/database/pool.ts";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";

import { endProcessPools } from "../../../../../core/test/fixtures/modules/database/testing.ts";

/**
 * Social-feed T-007-AC-5 (AC-165): the production feed route and the home
 * page read through the replica pool, never the primary, and fail closed
 * without a replica.
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

test("T-007-AC-5: feed reads take the replica pool, not the primary", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: REPLICA });
  const { socialFeedPool } = await import("@blast/server/modules/social/feed/runtime.ts");
  const replica = socialFeedPool();
  assert.equal(replica, replicaPool());
  assert.notEqual(replica, primaryPool());
  assert.equal(replica.options.connectionString, REPLICA);

  // The route reads through socialFeedDatabase, which is that pool.
  const source = await readFile(new URL(import.meta.resolve("@blast/server/modules/social/feed/runtime.ts")), "utf8");
  assert.match(source, /autocommitReader\(socialFeedPool\(\), "social"/);
  assert.match(source, /database: socialFeedDatabase/);
  assert.doesNotMatch(source, /primaryPool|databaseFor\(/);
});

test("T-007-AC-5: without a replica the feed fails closed instead of reading the primary", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: undefined });
  const { socialFeedDatabase } = await import("@blast/server/modules/social/feed/runtime.ts");
  assert.throws(() => socialFeedDatabase(), /DATABASE_REPLICA_URL is required/);
});

test("UI-03: the post item reads on the replica, and reactions write on the primary", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: REPLICA });
  const posts = await readFile(new URL(import.meta.resolve("@blast/server/modules/social/posts/runtime.ts")), "utf8");
  // The public item read uses the feed's replica database; the kit's transactions (reactions) are its primary.
  assert.match(posts, /database: socialFeedDatabase/);
  assert.match(posts, /kit: sharedSocialRouteKit\(\)/);
  assert.doesNotMatch(posts, /primaryPool|databaseFor\(/);
});
