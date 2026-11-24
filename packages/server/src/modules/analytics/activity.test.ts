import assert from "node:assert/strict";
import test from "node:test";
import { createAccountActivityService } from "./activity.ts";
import { accountActivityConfig, activityPoolConfig } from "./config.ts";

test("does no configuration, authentication or database work while disabled", async () => {
  const env = new Proxy(
    {},
    {
      get: (_target, key) => {
        assert.equal(key, "ANALYTICS_ACCOUNT_ACTIVITY_ENABLED");
        return undefined;
      },
    },
  );
  const service = createAccountActivityService(accountActivityConfig(env));
  try {
    const result = await service.handle(
      new Request("https://blast.fun/api/analytics/activity", { method: "POST" }),
    );
    assert.equal(result.status, 204);
    assert.equal(await result.text(), "");
  } finally {
    await service.close();
  }
});

test("fails retryably when enabled configuration is incomplete", async () => {
  const service = createAccountActivityService(
    accountActivityConfig({ ANALYTICS_ACCOUNT_ACTIVITY_ENABLED: "true" }),
  );
  try {
    const result = await service.handle(
      new Request("https://blast.fun/api/analytics/activity", { method: "POST" }),
    );
    assert.equal(result.status, 503);
    assert.equal(result.headers.get("retry-after"), "30");
    assert.equal(await result.text(), "");
  } finally {
    await service.close();
  }
});

test("checks the effective database host and refuses TLS or driver overrides", () => {
  const remote = activityPoolConfig(
    "postgresql://ingress:dummy@127.0.0.1/db?host=direct.example&sslmode=verify-full",
    "fixture",
  );
  assert.equal(remote.host, "direct.example");
  assert.deepEqual(remote.ssl, { rejectUnauthorized: true });
  assert.equal(remote.max, 1);
  assert.throws(
    () =>
      activityPoolConfig("postgresql://ingress:dummy@127.0.0.1/db?host=direct.example", "fixture"),
    { message: "Invalid account activity database configuration" },
  );
  assert.throws(
    () =>
      activityPoolConfig(
        "postgresql://ingress:dummy@direct.example/db?sslmode=verify-full&host=one&host=two",
        "fixture",
      ),
    { message: "Invalid account activity database configuration" },
  );
  assert.throws(
    () =>
      activityPoolConfig(
        "postgresql://ingress:dummy@direct-pooler.example/db?sslmode=verify-full",
        "fixture",
      ),
    { message: "Invalid account activity database configuration" },
  );
  assert.throws(
    () =>
      activityPoolConfig(
        "postgresql://ingress:dummy@direct.example/db?sslmode=verify-full&options=-c%20statement_timeout%3D0",
        "fixture",
      ),
    { message: "Invalid account activity database configuration" },
  );
  assert.throws(
    () =>
      activityPoolConfig(
        "postgresql://ingress:dummy@direct.example/db?sslmode=no-verify",
        "fixture",
      ),
    { message: "Invalid account activity database configuration" },
  );
});

test("permits only HTTPS or loopback HTTP collection origins", () => {
  const environment = {
    ANALYTICS_ACCOUNT_ACTIVITY_ENABLED: "true",
    ANALYTICS_ACCOUNT_HASH_KEY: "synthetic-account-key-never-production-32",
    ANALYTICS_IDENTITY_DATABASE_URL: "postgresql://identity:dummy@127.0.0.1/product",
    ANALYTICS_INGRESS_DATABASE_URL: "postgresql://ingress:dummy@127.0.0.1/warehouse",
    PRIVY_APP_ID: "synthetic-app",
    PRIVY_JWT_VERIFICATION_KEY: "synthetic-public-key",
  };
  assert.equal(
    accountActivityConfig({ ...environment, ANALYTICS_ACCOUNT_SITE_ORIGIN: "http://blast.fun" }),
    "unavailable",
  );
  assert.equal(
    accountActivityConfig({
      ...environment,
      ANALYTICS_ACCOUNT_SITE_ORIGIN: "https://user:secret@blast.fun",
    }),
    "unavailable",
  );
  const local = accountActivityConfig({
    ...environment,
    ANALYTICS_ACCOUNT_SITE_ORIGIN: "http://127.0.0.1:3000",
  });
  assert.ok(local !== null && local !== "unavailable");
  assert.equal(local.origin, "http://127.0.0.1:3000");
});
