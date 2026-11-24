import assert from "node:assert/strict";
import { test } from "node:test";

import { trustedUrl, type TrustedUrlRules } from "./trusted-origin.ts";

const NAME = "EXAMPLE_URL";
const ORIGIN: TrustedUrlRules = { shape: "origin", http: "loopback" };
const LOOPBACKS = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://127.5.6.7",
  "http://[::1]:8080",
];
const NOT_LOOPBACKS = [
  "http://blast.test",
  "http://128.0.0.1",
  "http://127.0.0.1.blast.test",
  "http://localhost.blast.test",
  "http://[::2]",
];

function refused(raw: string | undefined, rules: TrustedUrlRules, expected: string): void {
  assert.throws(
    () => trustedUrl(NAME, raw, rules),
    (error: Error) => error.message === `${NAME} ${expected}`,
    String(raw),
  );
}

test("a missing or empty value is required", () => {
  refused(undefined, ORIGIN, "is required.");
  refused("", ORIGIN, "is required.");
});

test("loopback http is one set: localhost, 127.0.0.0/8 and [::1]", () => {
  for (const raw of LOOPBACKS) {
    assert.equal(trustedUrl(NAME, raw, ORIGIN).protocol, "http:", raw);
  }

  for (const raw of NOT_LOOPBACKS) {
    refused(raw, ORIGIN, "must be a bare HTTPS origin (HTTP only on loopback).");
  }
});

test("http never refuses loopback and any accepts every host", () => {
  for (const raw of LOOPBACKS) {
    refused(raw, { shape: "origin", http: "never" }, "must be a bare HTTPS origin.");
    refused(raw, { shape: "url", http: "never" }, "must be an https URL.");
  }

  for (const raw of [...LOOPBACKS, ...NOT_LOOPBACKS]) {
    assert.equal(trustedUrl(NAME, raw, { shape: "origin", http: "any" }).protocol, "http:", raw);
  }
});

test("only http and https are accepted", () => {
  for (const http of ["never", "loopback", "any"] as const) {
    for (const raw of ["ftp://blast.test", "ws://localhost", "file:///etc/passwd", "blast.test"]) {
      assert.throws(() => trustedUrl(NAME, raw, { shape: "url", http }), /must be/, raw);
    }
  }
});

test("origin shape refuses credentials, path, query and hash", () => {
  for (const raw of [
    "https://user@blast.test",
    "https://user:pass@blast.test",
    "https://blast.test/path",
    "https://blast.test/?query=1",
    "https://blast.test/#hash",
  ]) {
    refused(raw, ORIGIN, "must be a bare HTTPS origin (HTTP only on loopback).");
  }
});

test("origin shape accepts a trailing slash and returns the bare origin", () => {
  assert.equal(trustedUrl(NAME, "https://blast.test/", ORIGIN).origin, "https://blast.test");
  assert.equal(trustedUrl(NAME, "https://blast.test", ORIGIN).origin, "https://blast.test");
});

test("url shape keeps credentials, path, query and hash", () => {
  const raw = "https://provider:key@grpc.blast.test/v1?token=abc#frag";

  assert.equal(trustedUrl(NAME, raw, { shape: "url", http: "never" }).href, raw);
});

test("plainHost refuses a wildcard host and keeps plain DNS and IP hosts", () => {
  const rules: TrustedUrlRules = { ...ORIGIN, plainHost: true };

  refused("https://*.blast.test", rules, "must be a bare HTTPS origin (HTTP only on loopback).");

  for (const raw of ["https://api.blast.test", "http://127.0.0.1:8080", "http://[::1]:8080"]) {
    assert.doesNotThrow(() => trustedUrl(NAME, raw, rules), raw);
  }

  assert.doesNotThrow(() => trustedUrl(NAME, "https://*.blast.test", ORIGIN));
});

test("no error repeats the value", () => {
  const secret = "s3cr3t-provider-key";

  for (const [raw, rules] of [
    [`http://${secret}.blast.test`, { shape: "url", http: "never" }],
    [`https://user:${secret}@blast.test`, ORIGIN],
    [`https://blast.test/${secret}`, ORIGIN],
    [`not a url ${secret}`, ORIGIN],
  ] as const) {
    assert.throws(
      () => trustedUrl(NAME, raw, rules),
      (error: Error) =>
        error.message.startsWith(NAME) &&
        !error.message.includes(secret) &&
        error.cause === undefined &&
        !Object.hasOwn(error, "input"),
      raw,
    );
  }
});
