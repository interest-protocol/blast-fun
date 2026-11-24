import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  populatedReaderBinding,
  readPopulatedReaderFixture,
} from "../apps/backend-api/test/populated-reader-fixture.ts";

/** No inherited fallback, remote connection, or libpq/Redis connection override. */
export function populatedDependency(raw, database = false) {
  assert.ok(
    typeof raw === "string" && raw.length > 0,
    "An explicit disposable dependency is required.",
  );
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Disposable dependency URL is invalid.");
  }
  assert.ok(
    (database ? ["postgres:", "postgresql:"] : ["redis:"]).includes(
      url.protocol,
    ) &&
      url.hostname === "127.0.0.1" &&
      Number(url.port) > 0 &&
      !raw.includes("?") &&
      !raw.includes("#"),
    "Disposable dependencies require explicit loopback ports without connection overrides.",
  );
  assert.ok(
    database
      ? url.username &&
          url.password &&
          /^\/[A-Za-z_][A-Za-z0-9_]*$/.test(url.pathname)
      : !url.username && !url.password && ["", "/"].includes(url.pathname),
    "Disposable dependency identity is invalid.",
  );
  return raw;
}

/** The caller owns local PG/Valkey and the bounded native fixture process. */
export function runPopulatedReader(
  environment = process.env,
  execute = spawnSync,
) {
  const profile = environment.BLAST_POPULATED_READER_PROFILE_MS;
  assert.ok(
    profile === undefined || profile === "120000",
    "The optional populated profile must be exactly 120000 ms.",
  );
  const binding = populatedReaderBinding(environment);
  const ready = environment.BLAST_POPULATED_FIXTURE_READY;
  const fixture = readPopulatedReaderFixture(ready, binding);
  assert.ok(
    !existsSync(fixture.completion_file),
    "Completion exists; this fixture cannot be reused.",
  );
  const report = join(dirname(ready), "consumer-result.json");
  assert.ok(
    !existsSync(report),
    "Consumer result exists; refuse to overwrite this run.",
  );
  let directory;
  let passed = false;
  let counts = { requests: 0, errors: 0 };
  try {
    assert.equal(
      process.versions.bun,
      "1.4.2",
      "Run with pinned native Bun 1.4.2 and --no-env-file.",
    );
    const key = environment.BLAST_BACKEND_READER_TEST_API_KEY;
    assert.ok(
      key && /^[\x21-\x7e]{32,512}$/.test(key),
      "An explicit synthetic native API key is required.",
    );
    const product = populatedDependency(
      environment.MISSION_CONTROL_TEST_DATABASE_URL,
      true,
    );
    const native = populatedDependency(
      environment.BLAST_POPULATED_FIXTURE_DATABASE_URL,
      true,
    );
    const redis = populatedDependency(environment.BLAST_TEST_REDIS_URL);
    directory = mkdtempSync(join(tmpdir(), "blast-populated-reader-"));
    const result = execute(
      process.execPath,
      [
        "--no-env-file",
        "test",
        "--max-concurrency",
        "1",
        "--timeout",
        profile ? "245000" : "125000",
        resolve(
          import.meta.dirname,
          "../apps/backend-api/test/populated-reader.integration.test.ts",
        ),
      ],
      {
        cwd: directory,
        stdio: "inherit",
        timeout: profile ? 260_000 : 140_000,
        env: {
          PATH: environment.PATH,
          HOME: environment.HOME,
          TZ: "UTC",
          NODE_OPTIONS: "--max-old-space-size=640",
          MISSION_CONTROL_TEST_DATABASE_URL: product,
          BLAST_POPULATED_FIXTURE_DATABASE_URL: native,
          BLAST_TEST_REDIS_URL: redis,
          BLAST_BACKEND_READER_TEST_API_KEY: key,
          BLAST_POPULATED_FIXTURE_READY: ready,
          BLAST_POPULATED_FIXTURE_NONCE: binding.nonce,
          BLAST_POPULATED_FIXTURE_EXPECTED_SOURCE_REVISION:
            binding.source_revision,
          BLAST_POPULATED_FIXTURE_EXPECTED_SOURCE_DIFF_SHA256:
            binding.source_diff_sha256,
          BLAST_POPULATED_FIXTURE_EXPECTED_EXECUTABLE_SHA256:
            binding.executable_sha256,
          BLAST_POPULATED_FIXTURE_EXPECTED_FIXTURE_MODULE_SHA256:
            binding.fixture_module_sha256,
          BLAST_POPULATED_FIXTURE_RESULT: report,
          ...(profile ? { BLAST_POPULATED_READER_PROFILE_MS: profile } : {}),
        },
      },
    );
    if (existsSync(report)) {
      const recorded = JSON.parse(readFileSync(report, "utf8"));
      assert.ok(
        Number.isSafeInteger(recorded.requests) &&
          recorded.requests >= 0 &&
          Number.isSafeInteger(recorded.errors) &&
          recorded.errors >= 0,
      );
      counts = { requests: recorded.requests, errors: recorded.errors };
      assert.ok(
        recorded.complete === true && recorded.passed === true,
        "Populated proof did not complete.",
      );
      assert.ok(
        recorded.requests > 0,
        "Populated proof must send actual requests.",
      );
      if (profile) {
        const result = recorded.sustained_profile;
        const workload = result?.profile;
        const labels = ["first_party", "partner_direct", "partner_relay"];
        const groups = workload?.groups;
        const validGroup = (label) => {
          const group = groups?.[label];
          const count = group?.attempts;
          const latency = group?.latency;
          return (
            Number.isSafeInteger(count) &&
            count > 0 &&
            group.valid === count &&
            result.completed?.[label] === count &&
            Object.keys(group.statuses ?? {}).length === 1 &&
            group.statuses["200"] === count &&
            Object.keys(group.errors ?? {}).length === 0 &&
            [latency?.p50Ms, latency?.p95Ms, latency?.p99Ms].every(
              (value) => Number.isFinite(value) && value >= 0,
            ) &&
            latency.p50Ms <= latency.p95Ms &&
            latency.p95Ms <= latency.p99Ms
          );
        };
        assert.ok(
          workload?.requestedDurationMs === 120_000 &&
            Number.isFinite(workload.elapsedMs) &&
            workload.elapsedMs >= 120_000 &&
            JSON.stringify(Object.keys(groups ?? {}).sort()) ===
              JSON.stringify(labels) &&
            labels.every(validGroup),
          "Requested sustained populated profile is missing or invalid.",
        );
      }
    } else {
      throw new Error(
        "Populated proof did not retain request counts; this run failed.",
      );
    }
    if (result.error)
      throw new Error("Populated proof child failed to complete.");
    assert.equal(
      result.status,
      0,
      "Actual populated native/admission/relay composition must pass.",
    );
    passed = true;
  } finally {
    try {
      if (directory) rmSync(directory, { recursive: true, force: true });
    } catch {
      passed = false;
      throw new Error("Populated proof scratch cleanup failed.");
    } finally {
      const completion = {
        schema_version: fixture.schema_version,
        scenario: fixture.scenario,
        ...binding,
        fixture_sha256: fixture.fixture_sha256,
        passed,
        ...counts,
      };
      const temporary = `${fixture.completion_file}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(completion) + "\n", {
          flag: "wx",
          mode: 0o600,
        });
        linkSync(temporary, fixture.completion_file);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  runPopulatedReader();
