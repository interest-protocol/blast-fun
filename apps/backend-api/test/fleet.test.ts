import assert from "node:assert/strict";
import test from "node:test";
import { validateBackendFleet, type BackendFleetEnvelope } from "../src/app/config/fleet.ts";
import { fleetFixture } from "./fleet-fixture.ts";

const local = { role: "api", maxHintStreams: 200, maxInflight: 64, maxApiReplicas: 8 } as const;
const environment = (plan: BackendFleetEnvelope) => ({
  BLAST_BACKEND_FLEET_CONFIG: JSON.stringify(plan),
});

test("isolated stream replicas add zero DB clients and quote workers", () => {
  const plan = fleetFixture();
  const api = validateBackendFleet(environment(plan), local)!;
  const hints = validateBackendFleet(environment(plan), {
    ...local,
    role: "hints",
    maxHintStreams: 512,
  })!;
  assert.equal(api.fingerprint, hints.fingerprint);
  assert.equal(api.streamsAfterFailure, 10_240);
  assert.deepEqual(api.demand, {
    primaryClients: 48,
    replicaClients: 40,
    reportingClients: 0,
    quotaRedisClients: 60,
    cacheRedisClients: 0,
    infraHintSockets: 0,
    quoteWorkers: 8,
  });
  assert.equal(api.totals.primaryClients, 52);
  assert.equal(api.measuredCapacity, false);
  plan.hints.replicas++;
  const larger = validateBackendFleet(environment(plan), local)!;
  assert.equal(larger.demand.primaryClients, api.demand.primaryClients);
  assert.equal(larger.demand.replicaClients, api.demand.replicaClients);
  assert.equal(larger.demand.quoteWorkers, api.demand.quoteWorkers);
  assert.equal(larger.demand.quotaRedisClients, api.demand.quotaRedisClients + 2);
  assert.equal(
    larger.demand.infraHintSockets,
    0,
    "without the market stream no hints process opens an engine socket",
  );
});

test("default-capacity stream arithmetic cannot silently claim 10000 visible tabs", () => {
  const plan = fleetFixture();
  plan.hints.maxHintStreams = 200;
  plan.hints.replicas = 32;
  assert.throws(() => validateBackendFleet(environment(plan), local), /after one process failure/);
  plan.hints.replicas = 33;
  assert.throws(() => validateBackendFleet(environment(plan), local), /fields/);
});

test("API and hint startup reject settings that diverge from the shared plan", () => {
  const plan = fleetFixture();
  assert.throws(
    () => validateBackendFleet(environment(plan), { ...local, maxApiReplicas: 3 }),
    /API settings/,
  );
  assert.throws(
    () => validateBackendFleet(environment(plan), { ...local, maxInflight: 63 }),
    /API settings/,
  );
  assert.throws(
    () => validateBackendFleet({ ...environment(plan), DATABASE_POOL_MAX: "11" }, local),
    /API settings/,
  );
  assert.throws(
    () => validateBackendFleet({ ...environment(plan), DATABASE_REPLICA_POOL_MAX: "11" }, local),
    /API settings/,
  );
  assert.throws(
    () =>
      validateBackendFleet(
        { ...environment(plan), BLAST_CACHE_REDIS_URL: "redis://localhost:6379" },
        local,
      ),
    /API settings/,
  );
  assert.throws(
    () =>
      validateBackendFleet(
        { ...environment(plan), DEFILLAMA_READ_DATABASE_URL: "postgres://localhost/reporting" },
        local,
      ),
    /API settings/,
  );
  assert.throws(
    () => validateBackendFleet(environment(plan), { ...local, role: "hints" }),
    /hint settings/,
  );
});

test("reporting aliases, cache sockets and external reserves are included in ceilings", () => {
  const plan = fleetFixture();
  plan.api.defillama = true;
  plan.api.cacheRedis = true;
  plan.ceilings.reportingClients = 8;
  plan.ceilings.cacheRedisClients = 4;
  const env = {
    ...environment(plan),
    DEFILLAMA_READ_DATABASE_URL: "postgres://localhost/reporting",
    BLAST_CACHE_REDIS_URL: "redis://localhost:6379",
  };
  const result = validateBackendFleet(env, local)!;
  assert.equal(result.demand.primaryClients, 56);
  assert.equal(result.demand.replicaClients, 48);
  assert.equal(result.demand.reportingClients, 8);
  assert.equal(result.demand.cacheRedisClients, 4);
  for (const key of Object.keys(plan.ceilings) as (keyof typeof plan.ceilings)[]) {
    const tooSmall = structuredClone(plan);
    tooSmall.ceilings[key] = result.totals[key] - 1;
    assert.throws(
      () => validateBackendFleet({ ...env, ...environment(tooSmall) }, local),
      new RegExp(key),
    );
  }
});

test("new hints profile requires a strict envelope while legacy API startup remains compatible", () => {
  assert.equal(validateBackendFleet({}, local), undefined);
  assert.throws(() => validateBackendFleet({}, { ...local, role: "hints" }), /required/);
  for (const raw of ["", "x", "{}", " ".repeat(32_769)]) {
    assert.throws(
      () => validateBackendFleet({ BLAST_BACKEND_FLEET_CONFIG: raw }, local),
      /fleet envelope/,
    );
  }
  const plan = { ...fleetFixture(), unexpected: "refuse" };
  assert.throws(
    () => validateBackendFleet({ BLAST_BACKEND_FLEET_CONFIG: JSON.stringify(plan) }, local),
    /fields/,
  );
});
