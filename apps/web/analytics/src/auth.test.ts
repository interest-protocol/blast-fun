import assert from "node:assert/strict";
import { test } from "node:test";
import { authConfig, cookie, cookieName, seal, session } from "./auth.ts";
import { accessDatabaseUrl } from "./access.ts";

const config = authConfig({
  ANALYTICS_DASHBOARD_ORIGIN: "https://analytics.example",
  ANALYTICS_SESSION_KEY: Buffer.alloc(32, 7).toString("base64url"),
});
test("sessions are encrypted, origin-bound, time-limited and reject tampering or ambiguous cookies", (context) => {
  context.mock.method(Date, "now", () => 1_700_000_000_000);
  const value = seal(config, {
    subject: `code:${"b".repeat(64)}`,
    expires: Date.now() + 14_000_000,
  });
  const header = `${cookieName(config)}=${value}`;
  assert.equal(session(config, header)?.subject, `code:${"b".repeat(64)}`);
  assert.doesNotMatch(value, /bbbbbbbb|code:/);
  assert.equal(
    session({ ...config, origin: "https://other.example" }, header),
    null,
  );
  assert.equal(session(config, `${header}; ${header}`), null);
  assert.equal(session(config, `${header}; broken`), null);
  assert.equal(session(config, `${header}; other=one,two`), null);
  assert.equal(session(config, `${header}; other=one; other=two`), null);
  assert.equal(session(config, header.slice(0, -5) + "xxxxx"), null);
  const malformedSubject = {
    subject: `code:${"b".repeat(64)}`,
    expires: Date.now() + 1,
  };
  // Model an untrusted decoded payload without widening the typed session writer.
  Reflect.set(malformedSubject, "subject", [malformedSubject.subject]);
  assert.equal(
    session(config, `${cookieName(config)}=${seal(config, malformedSubject)}`),
    null,
  );
  assert.equal(
    session(
      config,
      `${cookieName(config)}=${seal(config, { subject: `code:${"b".repeat(64)}`, expires: Date.now() + 1.5 })}`,
    ),
    null,
  );
  const extra = {
    subject: `code:${"b".repeat(64)}`,
    expires: Date.now() + 1,
    extra: true,
  };
  assert.equal(
    session(config, `${cookieName(config)}=${seal(config, extra)}`),
    null,
  );
  assert.equal(
    session(
      config,
      `${cookieName(config)}=${seal(config, { subject: `prefixcode:${"b".repeat(64)}`, expires: Date.now() + 1 })}`,
    ),
    null,
  );
  assert.equal(
    session(
      config,
      `${cookieName(config)}=${seal(config, { subject: `code:${"b".repeat(64)}suffix`, expires: Date.now() + 1 })}`,
    ),
    null,
  );
  assert.equal(
    session(
      config,
      `${cookieName(config)}=${seal(config, { subject: `code:${"b".repeat(64)}`, expires: Date.now() })}`,
    ),
    null,
  );
  assert.equal(
    session(
      config,
      `${cookieName(config)}=${seal(config, { subject: `code:${"b".repeat(64)}`, expires: Date.now() + 14_400_000 })}`,
    )?.expires,
    Date.now() + 14_400_000,
  );
  assert.equal(
    session(
      config,
      `${cookieName(config)}=${seal(config, { subject: `code:${"b".repeat(64)}`, expires: Date.now() - 1 })}`,
    ),
    null,
  );
  assert.equal(
    session(
      config,
      `${cookieName(config)}=${seal(config, { subject: `code:${"b".repeat(64)}`, expires: Date.now() + 14_500_000 })}`,
    ),
    null,
  );
  assert.match(
    cookie(config, value, 14400),
    /^__Host-blast_analytics_session=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=14400; Secure$/,
  );
});
test("configuration rejects noncanonical origins and key encodings with fixed errors", () => {
  const env = {
    ANALYTICS_DASHBOARD_ORIGIN: config.origin,
    ANALYTICS_SESSION_KEY: config.key.toString("base64url"),
  };
  assert.throws(
    () =>
      authConfig({
        ...env,
        ANALYTICS_DASHBOARD_ORIGIN: "https://analytics.example/#",
      }),
    { message: "Invalid dashboard origin" },
  );
  assert.throws(
    () =>
      authConfig({
        ...env,
        ANALYTICS_DASHBOARD_ORIGIN: "https://user:secret@analytics.example",
      }),
    { message: "Invalid dashboard origin" },
  );
  assert.throws(
    () =>
      authConfig({
        ...env,
        ANALYTICS_DASHBOARD_ORIGIN: "http://analytics.example",
      }),
    { message: "Invalid dashboard origin" },
  );
  assert.throws(
    () =>
      authConfig({
        ...env,
        ANALYTICS_SESSION_KEY: env.ANALYTICS_SESSION_KEY + "=",
      }),
    { message: "Private authentication is not configured" },
  );
  assert.equal(
    authConfig({
      ...env,
      NODE_ENV: "development",
      ANALYTICS_DASHBOARD_ORIGIN: "http://127.0.0.1:8989",
    }).secure,
    false,
  );
});
test("access URLs follow decoded effective-host semantics and refuse TLS ambiguity or pooled endpoints", () => {
  assert.equal(
    accessDatabaseUrl("postgresql://127.0.0.1/test"),
    "postgresql://127.0.0.1/test",
  );
  assert.equal(
    accessDatabaseUrl("postgres://remote/test?host=::1"),
    "postgres://remote/test?host=::1",
  );
  assert.equal(
    accessDatabaseUrl("postgres://127.0.0.1/test"),
    "postgres://127.0.0.1/test",
  );
  assert.equal(
    accessDatabaseUrl("postgres://[::1]/test"),
    "postgres://[::1]/test",
  );
  assert.equal(
    accessDatabaseUrl("postgres://remote/test?sslmode=verify-full"),
    "postgres://remote/test?sslmode=verify-full",
  );
  assert.throws(
    () => accessDatabaseUrl("https://remote/test?sslmode=verify-full"),
    { message: "Invalid access database" },
  );
  assert.equal(
    accessDatabaseUrl("postgres://local/test?host=%2Ftmp"),
    "postgres://local/test?host=%2Ftmp",
  );
  assert.equal(
    accessDatabaseUrl("postgres://%6cocalhost/test?host="),
    "postgres://%6cocalhost/test?host=",
  );
  assert.throws(
    () => accessDatabaseUrl("postgres://remote/test?host=&sslmode=disable"),
    { message: "Invalid access database" },
  );
  assert.throws(
    () =>
      accessDatabaseUrl(
        "postgres://secret@ep-POOLER.example/test?sslmode=verify-full",
      ),
    { message: "Invalid access database" },
  );
  assert.throws(
    () =>
      accessDatabaseUrl(
        "postgres://ep-%70ooler.example/test?sslmode=verify-full",
      ),
    { message: "Invalid access database" },
  );
  assert.throws(
    () =>
      accessDatabaseUrl(
        "postgres://remote/test?sslmode=verify-full&sslmode=disable",
      ),
    { message: "Invalid access database" },
  );
  assert.throws(
    () => accessDatabaseUrl("postgres://localhost/test?options=secret"),
    { message: "Invalid access database" },
  );
  assert.throws(() => accessDatabaseUrl("postgres://localhost/test?ssl=1"), {
    message: "Invalid access database",
  });
  assert.throws(() => accessDatabaseUrl("private-password-not-a-url"), {
    message: "Invalid access database",
  });
});
