import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { endProcessPools } from "../../../test/fixtures/modules/database/testing.ts";
import { databaseFor } from "./databases.ts";

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

test("databaseFor takes each workload's pool from the routing table", (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: REPLICA });
  const primary = primaryPool();
  for (const workload of ["write", "consistent-read", "social", "moderation"] as const) {
    assert.equal(databaseFor(workload), primary, workload);
  }
  assert.equal(primary.options.connectionString, PRIMARY);
  for (const workload of ["search", "thesis-join"] as const) {
    assert.equal(databaseFor(workload).options.connectionString, REPLICA, workload);
  }
  assert.notEqual(databaseFor("search"), primary);
});

test("chain joins fail closed without a replica instead of loading the primary", (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: undefined });
  assert.throws(() => databaseFor("search"), /DATABASE_REPLICA_URL is required/);
  assert.throws(() => databaseFor("thesis-join"), /DATABASE_REPLICA_URL is required/);
});
