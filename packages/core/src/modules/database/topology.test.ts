import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { createPool } from "./pool.ts";

import {
  isNeonUrl,
  migrationDatabaseUrl,
  primaryPooledUrl,
  partnerVerifierPooledUrl,
  replicaPooledUrl,
  watcherPooledUrl,
} from "./topology.ts";

const PRIMARY_POOLED =
  "postgresql://blast_app:app-secret@ep-bold-1-pooler.c-2.us-east-1.aws.neon.tech/blast?sslmode=verify-full";
const PRIMARY_DIRECT =
  "postgresql://blast_migrator:migrator-secret@ep-bold-1.c-2.us-east-1.aws.neon.tech/blast?sslmode=verify-full";
const REPLICA_POOLED =
  "postgresql://blast_reader:reader-secret@ep-calm-2-pooler.c-2.us-east-1.aws.neon.tech/blast?sslmode=verify-full";

const WATCHER_POOLED =
  "postgresql://blast_watch:watch-secret@ep-bold-1-pooler.c-2.us-east-1.aws.neon.tech/blast?sslmode=verify-full";

const production = {
  DATABASE_URL: PRIMARY_POOLED,
  DATABASE_MIGRATION_URL: PRIMARY_DIRECT,
  DATABASE_REPLICA_URL: REPLICA_POOLED,
  BLAST_DEPLOYMENT_TARGET: "production",
};

function refusal(read: () => unknown, expected: RegExp): void {
  assert.throws(read, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /secret|blast_app|blast_reader|blast_migrator|ep-/);
    return true;
  });
}

test("a colocated Neon primary, direct migration endpoint and replica are accepted", () => {
  assert.equal(primaryPooledUrl(production), PRIMARY_POOLED);
  assert.equal(replicaPooledUrl(production), REPLICA_POOLED);
  assert.equal(migrationDatabaseUrl(production), PRIMARY_DIRECT);
});

test("loopback databases need no Neon endpoint shape", () => {
  const local = {
    DATABASE_URL: "postgres://blast:blast@127.0.0.1:5433/blast",
    DATABASE_REPLICA_URL: "postgres://blast:blast@127.0.0.1:5433/blast?options=-c%20role%3Dblast_replica",
  };
  assert.equal(primaryPooledUrl(local), local.DATABASE_URL);
  assert.equal(replicaPooledUrl(local), local.DATABASE_REPLICA_URL);
  assert.equal(migrationDatabaseUrl(local), local.DATABASE_URL, "a local primary migrates itself");
});

test("a missing primary or replica endpoint fails closed instead of falling back", () => {
  refusal(() => primaryPooledUrl({}), /DATABASE_URL is required/);
  refusal(() => primaryPooledUrl({ DATABASE_URL: "   " }), /DATABASE_URL is required/);
  refusal(
    () => replicaPooledUrl({ DATABASE_URL: PRIMARY_POOLED }),
    /DATABASE_REPLICA_URL is required/,
  );
  refusal(() => replicaPooledUrl({ DATABASE_REPLICA_URL: REPLICA_POOLED }), /DATABASE_URL is required/);
  refusal(() => migrationDatabaseUrl({}), /DATABASE_MIGRATION_URL or DATABASE_URL is required/);
  refusal(
    () => migrationDatabaseUrl({ DATABASE_URL: PRIMARY_POOLED }),
    /DATABASE_MIGRATION_URL is required/,
  );
});

test("endpoints that point at an incompatible deployment are refused without leaking secrets", () => {
  const cases: Array<[Record<string, string>, (env: Record<string, string>) => unknown, RegExp]> = [
    [{ DATABASE_URL: "mysql://blast_app:app-secret@host/blast" }, primaryPooledUrl, /DATABASE_URL must be a PostgreSQL URL/],
    [{ DATABASE_URL: "not a url app-secret" }, primaryPooledUrl, /DATABASE_URL must be a PostgreSQL URL/],
    [{ DATABASE_URL: PRIMARY_DIRECT }, primaryPooledUrl, /DATABASE_URL must use the Neon pooled endpoint/],
    [{ DATABASE_URL: PRIMARY_POOLED.replace("?sslmode=verify-full", "") }, primaryPooledUrl, /DATABASE_URL must set sslmode=verify-full/],
    [{ DATABASE_URL: PRIMARY_POOLED.replace("sslmode=verify-full", "sslmode=prefer") }, primaryPooledUrl, /DATABASE_URL must set sslmode=verify-full/],
    [{ ...production, DATABASE_REPLICA_URL: REPLICA_POOLED.replace("-pooler", "") }, replicaPooledUrl, /DATABASE_REPLICA_URL must use the Neon pooled endpoint/],
    [{ ...production, DATABASE_REPLICA_URL: PRIMARY_POOLED.replace("blast_app:app-secret", "blast_reader:reader-secret") }, replicaPooledUrl, /DATABASE_REPLICA_URL must name the read replica, not the primary/],
    [{ ...production, DATABASE_REPLICA_URL: REPLICA_POOLED.replace("/blast?", "/other?") }, replicaPooledUrl, /DATABASE_REPLICA_URL must name the same database/],
    [{ DATABASE_URL: PRIMARY_POOLED, DATABASE_REPLICA_URL: REPLICA_POOLED.replace("us-east-1", "eu-west-2") }, replicaPooledUrl, /DATABASE_REPLICA_URL must be in the primary's region/],
    [{ ...production, DATABASE_REPLICA_URL: REPLICA_POOLED.replace("us-east-1", "eu-west-2") }, replicaPooledUrl, /DATABASE_REPLICA_URL must be in Neon region aws-us-east-1/],
    [{ DATABASE_URL: "postgres://blast:blast@127.0.0.1:5433/blast", DATABASE_REPLICA_URL: "postgres://blast:blast@127.0.0.1:5433/blast" }, replicaPooledUrl, /DATABASE_REPLICA_URL must name the read replica, not the primary/],
    [{ ...production, DATABASE_MIGRATION_URL: PRIMARY_POOLED.replace("blast_app:app-secret", "blast_migrator:migrator-secret") }, migrationDatabaseUrl, /DATABASE_MIGRATION_URL must use the Neon primary's direct endpoint/],
    [{ ...production, DATABASE_MIGRATION_URL: PRIMARY_DIRECT.replace("ep-bold-1", "ep-calm-2") }, migrationDatabaseUrl, /DATABASE_MIGRATION_URL must name the primary behind DATABASE_URL/],
    [{ ...production, DATABASE_MIGRATION_URL: PRIMARY_DIRECT.replace("/blast?", "/other?") }, migrationDatabaseUrl, /DATABASE_MIGRATION_URL must name the same database/],
    [{ ...production, DATABASE_MIGRATION_URL: PRIMARY_DIRECT.replace("blast_migrator:migrator-secret", "blast_app:app-secret") }, migrationDatabaseUrl, /DATABASE_MIGRATION_URL must use a different login than DATABASE_URL/],
    [{ ...production, DATABASE_URL: PRIMARY_POOLED.replaceAll("us-east-1", "eu-west-2") }, primaryPooledUrl, /DATABASE_URL must be in Neon region aws-us-east-1/],
    [{ ...production, DATABASE_URL: "postgres://blast:app-secret@127.0.0.1:5433/blast" }, primaryPooledUrl, /DATABASE_URL must be a Neon endpoint in production/],
  ];
  for (const [environment, read, expected] of cases) refusal(() => read(environment), expected);
});

test("a preview may use another Neon region, production may not", () => {
  const preview = {
    DATABASE_URL: PRIMARY_POOLED.replaceAll("us-east-1", "eu-west-2"),
    DATABASE_REPLICA_URL: REPLICA_POOLED.replaceAll("us-east-1", "eu-west-2"),
    BLAST_DEPLOYMENT_TARGET: "preview",
  };
  assert.equal(replicaPooledUrl(preview), preview.DATABASE_REPLICA_URL);
});

test("Neon endpoints are recognised by host only", () => {
  assert.equal(isNeonUrl(PRIMARY_POOLED), true);
  assert.equal(isNeonUrl("postgres://u:p@127.0.0.1/db?options=.neon.tech"), false);
  assert.equal(isNeonUrl("postgres://u:p@db.neon.tech.evil.test/db"), false);
  assert.equal(isNeonUrl("not a url"), false);
});

test("the watcher reaches only the primary's pooled endpoint, as its own login, and fails closed", () => {
  // The watcher's own process holds WATCHER_DATABASE_URL and needs no web endpoint.
  assert.equal(watcherPooledUrl({ WATCHER_DATABASE_URL: WATCHER_POOLED, BLAST_DEPLOYMENT_TARGET: "production" }), WATCHER_POOLED);
  const local = "postgres://blast:blast@127.0.0.1:5433/blast?options=-c%20role%3Dblast_watcher";
  assert.equal(watcherPooledUrl({ WATCHER_DATABASE_URL: local }), local);
  refusal(() => watcherPooledUrl({}), /WATCHER_DATABASE_URL is required/);
  refusal(() => watcherPooledUrl({ DATABASE_URL: PRIMARY_POOLED }), /WATCHER_DATABASE_URL is required/);
  refusal(
    () => watcherPooledUrl({ WATCHER_DATABASE_URL: WATCHER_POOLED.replace("-pooler", "") }),
    /WATCHER_DATABASE_URL must use the Neon pooled endpoint/,
  );
  refusal(
    () => watcherPooledUrl({ WATCHER_DATABASE_URL: WATCHER_POOLED.replace("?sslmode=verify-full", "") }),
    /WATCHER_DATABASE_URL must set sslmode=verify-full/,
  );
  refusal(
    () => watcherPooledUrl({ WATCHER_DATABASE_URL: WATCHER_POOLED.replaceAll("us-east-1", "eu-west-2"), BLAST_DEPLOYMENT_TARGET: "production" }),
    /WATCHER_DATABASE_URL must be in Neon region aws-us-east-1/,
  );
  refusal(
    () => watcherPooledUrl({ WATCHER_DATABASE_URL: WATCHER_POOLED, DATABASE_URL: WATCHER_POOLED }),
    /WATCHER_DATABASE_URL must use its own login/,
  );
});

test("a production worker applies the production endpoint rules without a backend target: no plaintext, foreign or other-region database", () => {
  const worker = { BLAST_WORKER_ENVIRONMENT: "production" };
  assert.equal(watcherPooledUrl({ ...worker, WATCHER_DATABASE_URL: WATCHER_POOLED }), WATCHER_POOLED);
  refusal(
    () => watcherPooledUrl({ ...worker, WATCHER_DATABASE_URL: "postgres://blast_watch:watch-secret@127.0.0.1:5432/blast" }),
    /WATCHER_DATABASE_URL must be a Neon endpoint in production/,
  );
  refusal(
    () => watcherPooledUrl({ ...worker, WATCHER_DATABASE_URL: "postgres://blast_watch:watch-secret@db.example.test:5432/blast?sslmode=verify-full" }),
    /WATCHER_DATABASE_URL must be a Neon endpoint in production/,
  );
  refusal(
    () => watcherPooledUrl({ ...worker, WATCHER_DATABASE_URL: WATCHER_POOLED.replaceAll("us-east-1", "eu-west-2") }),
    /WATCHER_DATABASE_URL must be in Neon region aws-us-east-1/,
  );
  // A non-production worker keeps the local and preview latitude.
  const local = "postgres://blast:blast@127.0.0.1:5433/blast";
  assert.equal(watcherPooledUrl({ BLAST_WORKER_ENVIRONMENT: "non-production", WATCHER_DATABASE_URL: local }), local);
});


test("every Neon endpoint refuses TLS modes without hostname verification", () => {
  for (const mode of ["verify-ca", "prefer", "disable", "no-verify", "Require"]) {
    refusal(() => primaryPooledUrl({ ...production, DATABASE_URL: PRIMARY_POOLED.replace("verify-full", mode) }), /DATABASE_URL must set sslmode=verify-full/);
    refusal(() => replicaPooledUrl({ ...production, DATABASE_REPLICA_URL: REPLICA_POOLED.replace("verify-full", mode) }), /DATABASE_REPLICA_URL must set sslmode=verify-full/);
    refusal(() => migrationDatabaseUrl({ ...production, DATABASE_MIGRATION_URL: PRIMARY_DIRECT.replace("verify-full", mode) }), /DATABASE_MIGRATION_URL must set sslmode=verify-full/);
    refusal(() => watcherPooledUrl({ WATCHER_DATABASE_URL: WATCHER_POOLED.replace("verify-full", mode) }), /WATCHER_DATABASE_URL must set sslmode=verify-full/);
  }
});

test("direct pool construction cannot bypass Neon TLS and duplicate modes are refused", async () => {
  refusal(() => createPool(PRIMARY_DIRECT.replace("verify-full", "no-verify")), /Database URL must set sslmode=verify-full/);
  refusal(() => primaryPooledUrl({ DATABASE_URL: `${PRIMARY_POOLED}&sslmode=no-verify` }), /DATABASE_URL must set sslmode=verify-full/);
  const pool = createPool(PRIMARY_DIRECT, { max: 1 });
  assert.equal(pool.options.connectionString, PRIMARY_DIRECT);
  await pool.end();
});

test("query parameters cannot override the endpoint or login checked by topology", () => {
  for (const parameter of ["host", "hostaddr", "port", "user", "password"]) {
    const url = `${PRIMARY_POOLED}&${parameter}=override`;
    refusal(() => primaryPooledUrl({ DATABASE_URL: url }), /DATABASE_URL must use the URL authority for connection identity/);
    refusal(() => createPool(url), /Database URL must use the URL authority for connection identity/);
  }
});


test("legacy Neon require URLs reach every pool as verify-full without changing identity", async () => {
  const legacy = (url: string) => url.replace("verify-full", "require");
  const environment = Object.fromEntries(Object.entries(production).map(([key, value]) => [key, legacy(value)]));
  assert.equal(primaryPooledUrl(environment), PRIMARY_POOLED);
  assert.equal(replicaPooledUrl(environment), REPLICA_POOLED);
  assert.equal(migrationDatabaseUrl(environment), PRIMARY_DIRECT);
  assert.equal(watcherPooledUrl({ WATCHER_DATABASE_URL: legacy(WATCHER_POOLED) }), WATCHER_POOLED);
  const pool = createPool(legacy(PRIMARY_DIRECT), { max: 1 });
  try {
    assert.equal(pool.options.connectionString, PRIMARY_DIRECT);
    const client = new Client(pool.options);
    assert.ok("connectionParameters" in client);
    const parameters = client.connectionParameters;
    assert.ok(parameters && typeof parameters === "object" && "ssl" in parameters);
    const tls = parameters.ssl;
    assert.ok(tls && typeof tls === "object");
    assert.ok(!("rejectUnauthorized" in tls) || tls.rejectUnauthorized !== false,
      "the driver must retain Node's certificate-verification default");
    assert.ok(!("checkServerIdentity" in tls) || tls.checkServerIdentity === undefined,
      "the driver must retain Node's hostname-verification default");
  } finally { await pool.end(); }
});


test("Neon legacy TLS compatibility cannot enable libpq overrides or duplicate modes", () => {
  for (const mode of ["require", "verify-full"]) {
    const url = PRIMARY_POOLED.replace("verify-full", mode);
    refusal(() => primaryPooledUrl({ DATABASE_URL: `${url}&uselibpqcompat=true` }), /must not set uselibpqcompat/);
    refusal(() => createPool(`${url}&sslmode=require`), /must set sslmode=verify-full/);
  }
});


test("legacy Neon TLS normalization does not rewrite non-Neon connections", () => {
  const local = "postgresql://fixture:fixture-secret@127.0.0.1:5432/blast?sslmode=require";
  assert.equal(primaryPooledUrl({ DATABASE_URL: local }), local);
});


test("partner verifier requires a distinct login on exactly the same pooled primary", () => {
  const verifier = PRIMARY_POOLED.replace("blast_app:app-secret", "blast_verify:verifier-secret");
  assert.equal(partnerVerifierPooledUrl({ ...production, PARTNER_VERIFIER_DATABASE_URL: verifier }), verifier);
  const local = { DATABASE_URL: "postgres://writer:app-secret@127.0.0.1:5433/blast",
    PARTNER_VERIFIER_DATABASE_URL: "postgres://verifier:verifier-secret@127.0.0.1:5433/blast" };
  assert.equal(partnerVerifierPooledUrl(local), local.PARTNER_VERIFIER_DATABASE_URL);
  for (const [value, expected] of [
    [undefined, /PARTNER_VERIFIER_DATABASE_URL is required/],
    [PRIMARY_POOLED, /different login/],
    [PRIMARY_DIRECT, /pooled endpoint/],
    [REPLICA_POOLED, /primary behind DATABASE_URL/],
    [verifier.replace("/blast?", "/other?"), /same database/],
    [verifier.replace("verify-full", "disable"), /sslmode=verify-full/],
    ["not a URL verifier-secret", /PostgreSQL URL/],
    [verifier + "&options=-c%20role%3Dblast_web", /must not override/],
  ] as const) refusal(() => partnerVerifierPooledUrl({ ...production, PARTNER_VERIFIER_DATABASE_URL: value }), expected);
  refusal(() => partnerVerifierPooledUrl({ ...local, PARTNER_VERIFIER_DATABASE_URL: local.PARTNER_VERIFIER_DATABASE_URL.replace(":5433", ":5434") }), /primary behind/);
});
