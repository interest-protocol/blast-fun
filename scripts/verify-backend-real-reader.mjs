import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readRealReaderFixture } from "../apps/backend-api/test/real-reader-fixture.ts";

function loopbackDependency(raw, name, protocols) {
  assert.ok(typeof raw === "string" && raw.length > 0, `Explicit disposable ${name} is required.`);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Disposable ${name} must be a valid URL.`); }
  assert.ok(protocols.includes(url.protocol) && url.hostname === "127.0.0.1" &&
    Number(url.port) > 0 && !url.hash, `Disposable ${name} must use an explicit127.0.0.1 port and supported protocol.`);
  if (name === "MISSION_CONTROL_TEST_DATABASE_URL") {
    assert.ok(url.username && url.password && /^\/[A-Za-z_][A-Za-z0-9_]*$/.test(url.pathname), "An explicit disposable database identity is required.");
    assert.ok([...url.searchParams].every(([key, value]) => key === "connect_timeout" && /^(?:[1-9]|[12][0-9]|30)$/.test(value)), "Disposable database connection overrides are forbidden.");
  } else {
    assert.ok(!url.search && ["", "/"].includes(url.pathname), "Disposable Redis connection overrides are forbidden.");
  }
  return raw;
}

/** Explicit local dependencies are provisioned and cleaned by the outer owned harness. */
export function runReaderBridge(environment = process.env, execute = spawnSync) {
  const handoff = environment.BLAST_BACKEND_READER_HANDOFF;
  const fixture = readRealReaderFixture(handoff);
  const continuation = resolve(dirname(handoff), "continue.json");
  assert.ok(!existsSync(continuation), "A handoff continuation already exists; refuse to reuse this run.");
  let privateDirectory;
  let passed = false;
  try {
    const key = environment.BLAST_BACKEND_READER_TEST_API_KEY;
    assert.ok(key && /^[\x21-\x7e]{32,512}$/.test(key), "Explicit synthetic BLAST_BACKEND_READER_TEST_API_KEY is required.");
    assert.equal(process.versions.bun, "1.4.2", "Run this gate with the backend's pinned native Bun 1.4.2; Node is not a backend runtime.");
    const database = loopbackDependency(environment.MISSION_CONTROL_TEST_DATABASE_URL, "MISSION_CONTROL_TEST_DATABASE_URL", ["postgres:", "postgresql:"]);
    const redis = loopbackDependency(environment.BLAST_TEST_REDIS_URL, "BLAST_TEST_REDIS_URL", ["redis:"]);
    privateDirectory = mkdtempSync(join(tmpdir(), "blast-reader-bridge-"));
    const checkout = resolve(import.meta.dirname, "..");
    const result = execute(process.execPath, ["--no-env-file", "test", "--max-concurrency", "1", "--timeout", "165000",
      resolve(checkout, "apps/backend-api/test/real-reader.integration.test.ts")],
    { cwd: privateDirectory, stdio: "inherit", timeout: 180_000,
      env: { PATH: environment.PATH, HOME: environment.HOME, TZ: "UTC",
        MISSION_CONTROL_TEST_DATABASE_URL: database, BLAST_TEST_REDIS_URL: redis,
        BLAST_BACKEND_READER_HANDOFF: handoff, BLAST_BACKEND_READER_TEST_API_KEY: key } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, "Actual Rust/admission/relay bridge must pass before releasing the Rust fixture.");
    passed = true;
  } finally {
    try {
      if (privateDirectory) rmSync(privateDirectory, { recursive: true, force: true });
    } catch (error) {
      passed = false;
      throw error;
    } finally {
      const temporary = `${continuation}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ nonce: fixture.nonce, passed }) + "\n", { flag: "wx" });
      renameSync(temporary, continuation);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runReaderBridge();
