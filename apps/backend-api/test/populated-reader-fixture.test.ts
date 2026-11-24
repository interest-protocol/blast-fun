import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
  parsePopulatedReaderFixture,
  readPopulatedReaderFixture,
  type PopulatedReaderBinding,
} from "./populated-reader-fixture.ts";

const binding: PopulatedReaderBinding = {
  nonce: "a".repeat(64),
  source_revision: "b".repeat(40),
  source_diff_sha256: "c".repeat(64),
  executable_sha256: "d".repeat(64),
  fixture_module_sha256: "e".repeat(64),
};
const id = (value: string) => `0x${value.repeat(64)}`;
const readyPath = "/tmp/populated-reader/ready.json";

function ready() {
  return {
    schema_version: 1,
    scenario: "presale-vault-v1",
    ...binding,
    network: "mainnet",
    deployment_fingerprint: "f".repeat(64),
    reader_origin: "http://127.0.0.1:49151",
    writer_origin: "http://127.0.0.1:49152",
    database_name: "blast_test_123_456_789",
    fixture_sha256: "1".repeat(64),
    final_checkpoint: "7",
    fixture_timestamp_ms: "1720000000000",
    producer_mode: "debug-test-process-native-committed-reader",
    archival_freshness_override: {
      max_lag_ms: "18446744073709551615",
      reason: "archival synthetic checkpoints; no live freshness claim",
    },
    ids: {
      presale_id: id("1"),
      vault_id: id("2"),
      pool_id: id("3"),
      wallet: id("4"),
      coin_type: `${id("5")}::coin::COIN`,
    },
    cases: [
      { id: "presale-detail", path: `/v1/presales/${id("1")}`, body: { presale_id: id("1") } },
      {
        id: "presale-commitments",
        path: `/v1/presales/${id("1")}/commitments?limit=2`,
        body: { commitments: [{}] },
      },
      {
        id: "presale-wallet",
        path: `/v1/presales/${id("1")}/wallets/${id("4")}`,
        body: { wallet: id("4") },
      },
      { id: "vault-detail", path: `/v1/vaults/${id("2")}`, body: { vault_id: id("2") } },
    ],
    completion_file: "/tmp/populated-reader/completion.json",
  };
}

// Fails if either native handoff is rejected or an unrecognized fixture is accepted.
test("populated handoff accepts only the current four native cases with exact source binding", async () => {
  assert.deepEqual(parsePopulatedReaderFixture(ready(), binding, readyPath), ready());
  const release = { ...ready(), producer_mode: "release-process-native-committed-reader" };
  assert.deepEqual(parsePopulatedReaderFixture(release, binding, readyPath), release);
  assert.throws(() =>
    parsePopulatedReaderFixture({ ...ready(), producer_mode: "other-reader" }, binding, readyPath),
  );
  assert.throws(() =>
    parsePopulatedReaderFixture({ ...ready(), network: "localnet" }, binding, readyPath),
  );
  assert.throws(() =>
    parsePopulatedReaderFixture({ ...ready(), unknown: true }, binding, readyPath),
  );
  const runnerPath = new URL(
    "../../../scripts/verify-backend-populated-reader.mjs",
    import.meta.url,
  ).href;
  const { runPopulatedReader } = await import(runnerPath);
  const directory = mkdtempSync(join(tmpdir(), "blast-populated-launcher-"));
  let privateCwd = "";
  try {
    const path = join(directory, "ready.json");
    const completion = join(directory, "completion.json");
    writeFileSync(path, JSON.stringify({ ...ready(), completion_file: completion }));
    const environment = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BLAST_POPULATED_FIXTURE_READY: path,
      BLAST_POPULATED_FIXTURE_NONCE: binding.nonce,
      BLAST_POPULATED_FIXTURE_EXPECTED_SOURCE_REVISION: binding.source_revision,
      BLAST_POPULATED_FIXTURE_EXPECTED_SOURCE_DIFF_SHA256: binding.source_diff_sha256,
      BLAST_POPULATED_FIXTURE_EXPECTED_EXECUTABLE_SHA256: binding.executable_sha256,
      BLAST_POPULATED_FIXTURE_EXPECTED_FIXTURE_MODULE_SHA256: binding.fixture_module_sha256,
      MISSION_CONTROL_TEST_DATABASE_URL: "postgres://local:synthetic@127.0.0.1:5432/product",
      BLAST_POPULATED_FIXTURE_DATABASE_URL: "postgres://local:synthetic@127.0.0.1:5433/native",
      BLAST_TEST_REDIS_URL: "redis://127.0.0.1:6379",
      BLAST_BACKEND_READER_TEST_API_KEY: "synthetic-key-".repeat(4),
      DATABASE_URL: "postgres://must-not-inherit.invalid/production",
      UNRELATED_SECRET: "must-not-inherit",
    };
    runPopulatedReader(
      environment,
      (
        executable: string,
        args: string[],
        options: { cwd: string; timeout: number; env: Record<string, string> },
      ) => {
        assert.equal(executable, process.execPath);
        assert.deepEqual(args.slice(0, 6), [
          "--no-env-file",
          "test",
          "--max-concurrency",
          "1",
          "--timeout",
          "125000",
        ]);
        assert.ok(args[6]!.endsWith("/apps/backend-api/test/populated-reader.integration.test.ts"));
        assert.equal(options.timeout, 140_000);
        assert.equal(options.env.DATABASE_URL, undefined);
        assert.equal(options.env.UNRELATED_SECRET, undefined);
        assert.deepEqual(
          Object.keys(options.env).sort(),
          [
            "PATH",
            "HOME",
            "TZ",
            "NODE_OPTIONS",
            "MISSION_CONTROL_TEST_DATABASE_URL",
            "BLAST_POPULATED_FIXTURE_DATABASE_URL",
            "BLAST_TEST_REDIS_URL",
            "BLAST_BACKEND_READER_TEST_API_KEY",
            "BLAST_POPULATED_FIXTURE_READY",
            "BLAST_POPULATED_FIXTURE_NONCE",
            "BLAST_POPULATED_FIXTURE_EXPECTED_SOURCE_REVISION",
            "BLAST_POPULATED_FIXTURE_EXPECTED_SOURCE_DIFF_SHA256",
            "BLAST_POPULATED_FIXTURE_EXPECTED_EXECUTABLE_SHA256",
            "BLAST_POPULATED_FIXTURE_EXPECTED_FIXTURE_MODULE_SHA256",
            "BLAST_POPULATED_FIXTURE_RESULT",
          ].sort(),
        );
        assert.equal(options.env.BLAST_POPULATED_FIXTURE_NONCE, binding.nonce);
        assert.deepEqual(readdirSync(options.cwd), []);
        assert.equal(statSync(options.cwd).mode & 0o777, 0o700);
        privateCwd = options.cwd;
        writeFileSync(
          options.env.BLAST_POPULATED_FIXTURE_RESULT!,
          JSON.stringify({ requests: 13, errors: 4, complete: true, passed: true }),
        );
        return { status: 0 };
      },
    );
    assert.equal(existsSync(privateCwd), false);
    assert.deepEqual(JSON.parse(readFileSync(completion, "utf8")), {
      schema_version: 1,
      scenario: "presale-vault-v1",
      ...binding,
      fixture_sha256: ready().fixture_sha256,
      passed: true,
      requests: 13,
      errors: 4,
    });
    assert.throws(() =>
      runPopulatedReader(environment, () =>
        assert.fail("A completed handoff must never launch twice."),
      ),
    );
    rmSync(completion);
    rmSync(join(directory, "consumer-result.json"));
    assert.throws(() =>
      runPopulatedReader(
        {
          ...environment,
          BLAST_POPULATED_FIXTURE_DATABASE_URL: "postgres://u:p@remote.invalid/db",
        },
        () => assert.fail("Remote database cannot launch a child."),
      ),
    );
    assert.equal(JSON.parse(readFileSync(completion, "utf8")).passed, false);
    rmSync(completion);
    assert.throws(
      () =>
        runPopulatedReader({ ...environment, BLAST_POPULATED_READER_PROFILE_MS: "" }, () =>
          assert.fail("An invalid profile must not start the consumer."),
        ),
      /must be exactly 120000 ms/,
    );
    assert.throws(
      () =>
        runPopulatedReader({ ...environment, BLAST_POPULATED_READER_PROFILE_MS: "119999" }, () =>
          assert.fail("An invalid profile must not start the consumer."),
        ),
      /must be exactly 120000 ms/,
    );
    assert.equal(existsSync(completion), false);
    const group = {
      attempts: 2,
      valid: 2,
      statuses: { "200": 2 },
      errors: {},
      latency: { p50Ms: 1, p95Ms: 2, p99Ms: 3 },
    };
    const profile = {
      profile: {
        requestedDurationMs: 120_000,
        elapsedMs: 120_001,
        groups: { first_party: group, partner_direct: group, partner_relay: group },
      },
      completed: { first_party: 2, partner_direct: 2, partner_relay: 2 },
    };

    function runProfile(sustained_profile: unknown) {
      rmSync(completion, { force: true });
      rmSync(join(directory, "consumer-result.json"), { force: true });
      return runPopulatedReader(
        { ...environment, BLAST_POPULATED_READER_PROFILE_MS: "120000" },
        (
          _executable: string,
          args: string[],
          options: { timeout: number; env: Record<string, string> },
        ) => {
          assert.equal(args[5], "245000");
          assert.equal(options.timeout, 260_000);
          assert.equal(options.env.BLAST_POPULATED_READER_PROFILE_MS, "120000");
          writeFileSync(
            options.env.BLAST_POPULATED_FIXTURE_RESULT!,
            JSON.stringify({
              requests: 13,
              errors: 4,
              complete: true,
              passed: true,
              sustained_profile,
            }),
          );
          return { status: 0 };
        },
      );
    }

    const invalidProfile = /Requested sustained populated profile is missing or invalid/;
    assert.throws(() => runProfile(null), invalidProfile);
    assert.equal(JSON.parse(readFileSync(completion, "utf8")).passed, false);
    assert.throws(
      () =>
        runProfile({ ...profile, profile: { ...profile.profile, requestedDurationMs: 119_999 } }),
      invalidProfile,
    );
    assert.throws(
      () => runProfile({ ...profile, profile: { ...profile.profile, elapsedMs: 119_999 } }),
      invalidProfile,
    );
    assert.throws(
      () =>
        runProfile({
          ...profile,
          profile: { ...profile.profile, groups: { first_party: group, partner_direct: group } },
        }),
      invalidProfile,
    );
    assert.throws(
      () =>
        runProfile({
          ...profile,
          profile: { ...profile.profile, groups: { ...profile.profile.groups, extra: group } },
        }),
      invalidProfile,
    );
    const withRelay = (partner_relay: unknown, completed = 2) => ({
      ...profile,
      profile: { ...profile.profile, groups: { ...profile.profile.groups, partner_relay } },
      completed: { ...profile.completed, partner_relay: completed },
    });
    assert.throws(() => runProfile(withRelay({ ...group, valid: 1 })), invalidProfile);
    assert.throws(
      () => runProfile(withRelay({ ...group, attempts: 0, valid: 0, statuses: { "200": 0 } }, 0)),
      invalidProfile,
    );
    assert.throws(
      () =>
        runProfile(
          withRelay({ ...group, attempts: 1.5, valid: 1.5, statuses: { "200": 1.5 } }, 1.5),
        ),
      invalidProfile,
    );
    assert.throws(() => runProfile(withRelay(group, 1)), invalidProfile);
    assert.throws(
      () => runProfile(withRelay({ ...group, statuses: { "200": 2, "503": 1 } })),
      invalidProfile,
    );
    assert.throws(
      () => runProfile(withRelay({ ...group, statuses: { "200": 1 } })),
      invalidProfile,
    );
    assert.throws(
      () => runProfile(withRelay({ ...group, errors: { validation: 1 } })),
      invalidProfile,
    );
    assert.throws(
      () => runProfile(withRelay({ ...group, latency: { p50Ms: -1, p95Ms: 2, p99Ms: 3 } })),
      invalidProfile,
    );
    assert.throws(
      () => runProfile(withRelay({ ...group, latency: { p50Ms: null, p95Ms: 2, p99Ms: 3 } })),
      invalidProfile,
    );
    assert.throws(
      () => runProfile(withRelay({ ...group, latency: { p50Ms: 3, p95Ms: 2, p99Ms: 3 } })),
      invalidProfile,
    );
    assert.throws(
      () => runProfile(withRelay({ ...group, latency: { p50Ms: 1, p95Ms: 3, p99Ms: 2 } })),
      invalidProfile,
    );
    runProfile(profile);
    assert.equal(JSON.parse(readFileSync(completion, "utf8")).passed, true);
  } finally {
    if (privateCwd) {
      rmSync(privateCwd, { recursive: true, force: true });
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

// Fails if a stale executable, changed source or reused nonce can be trusted from the ready file alone.
test("populated handoff rejects every mismatched outer source identity and nonce", () => {
  for (const field of Object.keys(binding) as (keyof PopulatedReaderBinding)[]) {
    assert.throws(() =>
      parsePopulatedReaderFixture(
        ready(),
        { ...binding, [field]: "0".repeat(binding[field].length) },
        readyPath,
      ),
    );
  }
});

// Fails if URL normalization hides remote hosts, credentials, empty queries, paths or duplicate endpoints.
test("populated handoff accepts canonical distinct loopback origins only", () => {
  for (const reader_origin of [
    "https://127.0.0.1:49151",
    "http://localhost:49151",
    "http://192.0.2.1:49151",
    "http://u:p@127.0.0.1:49151",
    "http://127.0.0.1:49151?",
    "http://127.0.0.1:49151#",
    "http://127.0.0.1:49151/",
    "http://127.0.0.1:049151",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:80",
    ready().writer_origin,
  ]) {
    assert.throws(() =>
      parsePopulatedReaderFixture({ ...ready(), reader_origin }, binding, readyPath),
    );
  }
  assert.equal(
    parsePopulatedReaderFixture(
      { ...ready(), reader_origin: "http://127.0.0.1:65535" },
      binding,
      readyPath,
    ).reader_origin,
    "http://127.0.0.1:65535",
  );
});

// Fails if a missing populated identity, substituted route or oversized handoff can reach local services.
test("populated handoff rejects malformed IDs, case substitutions and unbounded files", () => {
  assert.throws(
    () => parsePopulatedReaderFixture(ready(), binding, "relative/ready.json"),
    /absolute/,
  );
  for (const ids of [
    { ...ready().ids, presale_id: "0x1" },
    { ...ready().ids, pool_id: "0x1" },
    { ...ready().ids, wallet: undefined },
  ]) {
    assert.throws(() => parsePopulatedReaderFixture({ ...ready(), ids }, binding, readyPath));
  }
  const cases = ready().cases;
  cases[0]!.path = "/v1/presales/another-sale";
  assert.throws(() => parsePopulatedReaderFixture({ ...ready(), cases }, binding, readyPath));
  assert.throws(() =>
    parsePopulatedReaderFixture(
      { ...ready(), completion_file: "/tmp/elsewhere/completion.json" },
      binding,
      readyPath,
    ),
  );
  const directory = mkdtempSync(join(tmpdir(), "blast-populated-contract-"));
  assert.throws(() =>
    parsePopulatedReaderFixture({ ...ready(), final_checkpoint: "0" }, binding, readyPath),
  );
  assert.throws(() =>
    parsePopulatedReaderFixture({ ...ready(), fixture_timestamp_ms: "0" }, binding, readyPath),
  );
  try {
    const path = join(directory, "ready.json");
    const valid = JSON.stringify({
      ...ready(),
      completion_file: join(directory, "completion.json"),
    });
    writeFileSync(path, valid.padEnd(1_048_577, " "));
    assert.throws(() => readPopulatedReaderFixture(path, binding), /1 MiB/);
    writeFileSync(path, valid.padEnd(1_048_576, " "));
    assert.equal(readPopulatedReaderFixture(path, binding).nonce, binding.nonce);
    assert.throws(
      () => readPopulatedReaderFixture(relative(process.cwd(), path), binding),
      /absolute/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
