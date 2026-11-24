import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export type RealReaderFixture = Readonly<{
  schema_version: 1;
  nonce: string;
  reader_origin: string;
  writer_origin: string;
  network: "localnet";
  deployment_fingerprint: string;
  binary_sha256: string;
  pool_keys: string[];
}>;

export function loopbackOrigin(raw: string): string {
  const url = new URL(raw);
  assert.ok(
    url.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password,
    "Real-reader verification accepts explicit bare HTTP loopback origins only.",
  );
  return url.origin;
}

export function readRealReaderFixture(path: string | undefined): RealReaderFixture {
  assert.ok(
    path && isAbsolute(path),
    "BLAST_BACKEND_READER_HANDOFF must identify an absolute ready.json path.",
  );
  const fixture = JSON.parse(readFileSync(path, "utf8")) as RealReaderFixture;
  assert.equal(fixture.schema_version, 1);
  assert.match(fixture.nonce, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(fixture.network, "localnet", "This bridge must never use a hosted/product network.");
  assert.match(fixture.deployment_fingerprint, /^[0-9a-f]{64}$/);
  assert.match(fixture.binary_sha256, /^[0-9a-f]{64}$/);
  assert.equal(loopbackOrigin(fixture.reader_origin), fixture.reader_origin);
  assert.equal(loopbackOrigin(fixture.writer_origin), fixture.writer_origin);
  assert.notEqual(fixture.reader_origin, fixture.writer_origin);
  assert.ok(
    Array.isArray(fixture.pool_keys) &&
      fixture.pool_keys.some((key) => /^blast_curve:0x[0-9a-f]{64}$/.test(key)),
    "A canonical real launch curve is mandatory; an empty fixture must not pass.",
  );
  return fixture;
}
