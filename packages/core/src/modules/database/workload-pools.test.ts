import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { endProcessPools } from "../../../test/fixtures/modules/database/testing.ts";

const PRIMARY = "postgresql://app:app-secret@127.0.0.1:9/primary_never_connected";
const REPLICA = "postgresql://reader:reader-secret@127.0.0.1:9/primary_never_connected?application_name=replica";

/** A fresh copy of pool.ts, as Next.js loads one per bundle layer. */
async function poolModule(copy: string): Promise<typeof import("./pool.ts")> {
  return import(`${new URL("./pool.ts", import.meta.url).href}?copy=${copy}`);
}

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

test("one replica pool per process, apart from the primary", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: REPLICA, DATABASE_REPLICA_POOL_MAX: "7" });
  const first = await poolModule("replica-1");
  const second = await poolModule("replica-2");

  const primary = first.primaryPool();
  assert.equal(primary.options.connectionString, PRIMARY);
  const replica = first.replicaPool();
  assert.notEqual(replica, primary);
  assert.equal(second.replicaPool(), replica, "one replica pool per process");
  assert.equal(replica.options.connectionString, REPLICA);
  assert.equal(replica.options.max, 7);
  assert.equal(replica.options.application_name, "blast-replica");
  assert.equal(second.transactionTimeoutsFor(replica)?.statementTimeoutMs, 8_000);
});

test("the replica pool fails closed without a replica endpoint", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: undefined });
  const pools = await poolModule("no-replica");
  assert.throws(() => pools.replicaPool(), /DATABASE_REPLICA_URL is required/);
});

test("the runtime primary refuses a direct Neon endpoint", async (t) => {
  withEnvironment(t, {
    DATABASE_URL: "postgresql://app:app-secret@ep-bold-1.us-east-1.aws.neon.tech/blast?sslmode=verify-full",
  });
  const pools = await poolModule("direct-primary");
  assert.throws(() => pools.primaryPool(), /DATABASE_URL must use the Neon pooled endpoint/);
  assert.throws(() => pools.createPool(), /DATABASE_URL must use the Neon pooled endpoint/);
});

test("replica pool limits are configurable and bounded", async () => {
  const { replicaPoolSettingsFromEnvironment } = await poolModule("replica-settings");
  assert.equal(replicaPoolSettingsFromEnvironment({}).max, 10);
  assert.equal(replicaPoolSettingsFromEnvironment({ DATABASE_POOL_MAX: "4" }).max, 10, "primary max is separate");
  assert.equal(replicaPoolSettingsFromEnvironment({ DATABASE_REPLICA_POOL_MAX: "50" }).max, 50);
  assert.equal(
    replicaPoolSettingsFromEnvironment({ DATABASE_STATEMENT_TIMEOUT_MS: "2000" }).statementTimeoutMs,
    2_000,
  );
  assert.throws(() => replicaPoolSettingsFromEnvironment({ DATABASE_REPLICA_POOL_MAX: "0" }), /DATABASE_REPLICA_POOL_MAX/);
  assert.throws(() => replicaPoolSettingsFromEnvironment({ DATABASE_REPLICA_POOL_MAX: "51" }), /DATABASE_REPLICA_POOL_MAX/);
});

test("the watcher pool holds at most two connections with the web runtime's timeouts", async () => {
  const { poolSettingsFromEnvironment, watcherPoolSettingsFromEnvironment } = await poolModule("watcher-settings");
  const timeouts = { DATABASE_STATEMENT_TIMEOUT_MS: "2000", DATABASE_LOCK_TIMEOUT_MS: "700" };
  const watcher = watcherPoolSettingsFromEnvironment(timeouts);
  assert.equal(watcher.max, 2);
  assert.deepEqual({ ...watcher, max: 0 }, { ...poolSettingsFromEnvironment(timeouts), max: 0 });
  assert.equal(watcherPoolSettingsFromEnvironment({ DATABASE_POOL_MAX: "40" }).max, 2, "the web pool size never applies");
  assert.equal(watcherPoolSettingsFromEnvironment({ WATCHER_DATABASE_POOL_MAX: "1" }).max, 1);
  assert.throws(() => watcherPoolSettingsFromEnvironment({ WATCHER_DATABASE_POOL_MAX: "3" }), /WATCHER_DATABASE_POOL_MAX/);
  assert.throws(() => watcherPoolSettingsFromEnvironment({ WATCHER_DATABASE_POOL_MAX: "0" }), /WATCHER_DATABASE_POOL_MAX/);
});

test("partner verification has its own required read login and two-connection pool", async (t) => {
  const verifier = PRIMARY.replace("app:app-secret", "verifier:verifier-secret");
  withEnvironment(t, { DATABASE_URL: PRIMARY, PARTNER_VERIFIER_DATABASE_URL: verifier });
  const first = await poolModule("verifier-1");
  const second = await poolModule("verifier-2");
  const reader = first.partnerVerifierPool();
  assert.equal(second.partnerVerifierPool(), reader);
  assert.equal(reader.options.connectionString, verifier);
  assert.equal(reader.options.application_name, "blast-partner-verifier");
  assert.equal(reader.options.max, 2);
  assert.equal(reader.options.query_timeout, 750);
  assert.notEqual(reader, first.primaryPool());
  assert.equal(first.primaryPool().options.connectionString, PRIMARY);
  await Promise.all([first.endPartnerVerifierPool(), second.endPartnerVerifierPool()]);
  assert.notEqual(second.partnerVerifierPool(), reader, "shutdown forgets the closed pool");
});

test("missing verifier never opens the writer pool as a substitute", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, PARTNER_VERIFIER_DATABASE_URL: undefined });
  const pools = await poolModule("no-verifier");
  assert.throws(() => pools.partnerVerifierPool(), /PARTNER_VERIFIER_DATABASE_URL is required/);
  await pools.endPartnerVerifierPool();
});
