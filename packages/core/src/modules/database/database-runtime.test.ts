import assert from "node:assert/strict";
import test from "node:test";

import { errorLabel } from "@blast/core/lib/metrics.ts";
import { DatabaseError, type Pool } from "pg";

import { isDatabaseUnavailableError } from "@blast/core/modules/database/availability.ts";
import { createRuntimePool, poolSettingsFromEnvironment } from "@blast/core/modules/database/pool.ts";
import {
  databaseErrorCause,
  DEFAULT_TRANSACTION_RETRY,
  isTransientDatabaseError,
  retryDelayMs,
  retryTransient,
} from "@blast/core/modules/database/retry.ts";
import { autocommitRead, withTransaction } from "@blast/core/modules/database/transaction.ts";

function sqlError(code: string): Error & { code: string } {
  return Object.assign(new Error(`sqlstate ${code}`), { code });
}

test("only rolled-back SQLSTATEs are transient", () => {
  for (const code of ["40001", "40P01", "55P03"]) {
    assert.equal(isTransientDatabaseError(sqlError(code)), true, code);
  }
  for (const code of ["23505", "57014", "08006", "ECONNRESET"]) {
    assert.equal(isTransientDatabaseError(sqlError(code)), false, code);
  }
  assert.equal(isTransientDatabaseError(new Error("plain")), false);
  assert.equal(isTransientDatabaseError(null), false);
});

test("database unavailability is saturation, lost connections and timeouts, never a bug", () => {
  for (const error of [
    new Error("timeout exceeded when trying to connect"),
    new Error("Connection terminated due to connection timeout"),
    new Error("Connection terminated unexpectedly"),
    new Error("Query read timeout"),
    ...["40001", "40P01", "55P03", "57014", "57P01", "57P03", "53300", "08006", "25P03"].map(sqlError),
    ...["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].map(sqlError),
  ]) {
    assert.equal(isDatabaseUnavailableError(error), true, error.message);
  }
  for (const error of [
    ...["23505", "23514", "22P02", "42P01", "42703"].map(sqlError),
    new TypeError("Cannot read properties of undefined"),
    new Error("timeout exceeded when trying to connect to the vendor"),
    "timeout exceeded when trying to connect",
    null,
    undefined,
  ]) {
    assert.equal(isDatabaseUnavailableError(error), false, String(error));
  }
});

test("wrapped database errors are classified by their innermost cause", async () => {
  const wrapped = (cause: Error) => new Error("select $1", { cause });
  for (const code of ["40001", "55P03", "53300", "08006", "ECONNRESET"]) {
    assert.equal(isDatabaseUnavailableError(wrapped(sqlError(code))), true, code);
  }
  assert.equal(isDatabaseUnavailableError(wrapped(sqlError("23505"))), false);
  assert.equal(isDatabaseUnavailableError(wrapped(new Error("Query read timeout"))), true);
  const first = new Error("first");
  const second = new Error("second", { cause: first });
  first.cause = second;
  assert.equal(databaseErrorCause(first), first);

  for (const [code, expected] of [["40001", 4], ["55P03", 2], ["ECONNRESET", 1]] as const) {
    let attempts = 0;
    await assert.rejects(
      retryTransient(async () => {
        attempts += 1;
        throw wrapped(sqlError(code));
      }, { attempts: 4, baseDelayMs: 0, maxDelayMs: 0 }),
      /select \$1/,
    );
    assert.equal(attempts, expected, code);
  }
});

test("retry delays use full jitter under a capped exponential ceiling", () => {
  const policy = { attempts: 6, baseDelayMs: 20, maxDelayMs: 100 };
  assert.equal(retryDelayMs(1, policy, () => 0), 0);
  assert.equal(retryDelayMs(1, policy, () => 0.999), 19);
  assert.equal(retryDelayMs(2, policy, () => 0.999), 39);
  assert.equal(retryDelayMs(3, policy, () => 0.999), 79);
  assert.equal(retryDelayMs(5, policy, () => 0.999), 99, "capped at maxDelayMs");
  for (let attempt = 1; attempt < 10; attempt += 1) {
    const delay = retryDelayMs(attempt, DEFAULT_TRANSACTION_RETRY);
    assert.ok(delay >= 0 && delay < DEFAULT_TRANSACTION_RETRY.maxDelayMs);
  }
});

test("transient failures retry until the attempt bound, others fail at once", async () => {
  const sleeps: number[] = [];
  const hooks = { random: () => 0.5, sleep: async (ms: number) => void sleeps.push(ms) };

  let calls = 0;
  const value = await retryTransient(async (attempt) => {
    calls += 1;
    if (attempt < 3) throw sqlError("40001");
    return "committed";
  }, DEFAULT_TRANSACTION_RETRY, hooks);
  assert.equal(value, "committed");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]);

  calls = 0;
  await assert.rejects(
    retryTransient(async () => {
      calls += 1;
      throw sqlError("40P01");
    }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 }, hooks),
    { code: "40P01" },
  );
  assert.equal(calls, 3, "bounded by attempts");

  calls = 0;
  await assert.rejects(
    retryTransient(async () => {
      calls += 1;
      throw sqlError("23505");
    }, DEFAULT_TRANSACTION_RETRY, hooks),
    { code: "23505" },
  );
  assert.equal(calls, 1, "unique violations are answers, not retries");

  await assert.rejects(
    retryTransient(async () => "never", { attempts: 0, baseDelayMs: 0, maxDelayMs: 0 }),
    /outside its bounds/,
  );
});

test("a lock timeout is retried once, not until the budget runs out", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransient(async () => {
      calls += 1;
      throw sqlError("55P03");
    }, { attempts: 6, baseDelayMs: 0, maxDelayMs: 0 }, { sleep: async () => undefined }),
    { code: "55P03" },
  );
  assert.equal(calls, 2);
});

test("BEGIN on a dead pooled connection retries once on a fresh client", async () => {
  const released: (Error | undefined)[] = [];
  const statements: string[] = [];
  let connections = 0;
  function fakeClient(dead: boolean) {
    return {
      on() {},
      removeListener() {},
      release(error?: Error) {
        released.push(error);
      },
      async query(text: string) {
        statements.push(text);
        if (dead && text.startsWith("BEGIN")) {
          throw Object.assign(new Error("Connection terminated unexpectedly"), { code: undefined });
        }
        return { command: text.split(" ")[0], rows: [{ ok: 1 }] };
      },
    };
  }
  const pool = {
    async connect() {
      connections += 1;
      return fakeClient(connections === 1);
    },
  } as unknown as Pool;
  const result = await withTransaction(pool, (transaction) => transaction.read("SELECT 1"));
  assert.deepEqual(result.rows, [{ ok: 1 }]);
  assert.equal(connections, 2);
  assert.ok(released[0] instanceof Error, "the dead client is destroyed, not pooled");
  assert.equal(released[1], undefined);
  assert.deepEqual(statements.slice(-2), ["SELECT 1", "COMMIT"]);

  // A SQL error at BEGIN is an answer from PostgreSQL, not a dead socket.
  let sqlConnections = 0;
  const sqlPool = {
    async connect() {
      sqlConnections += 1;
      return {
        on() {},
        removeListener() {},
        release() {},
        async query() {
          throw sqlError("25001");
        },
      };
    },
  } as unknown as Pool;
  await assert.rejects(withTransaction(sqlPool, async () => undefined), { code: "25001" });
  assert.equal(sqlConnections, 1);
});

test("a BEGIN that ran into the pool's query timeout is not resent on a fresh client", async () => {
  // A runtime pool that never connects: its clients are fakes whose BEGIN
  // answers after `delayMs` with pg's client-side timeout or a dead socket.
  const pool = createRuntimePool("postgresql://unused@127.0.0.1:1/unused", {
    ...poolSettingsFromEnvironment({}),
    statementTimeoutMs: 50,
  });
  let connections = 0;
  const released: (Error | undefined)[] = [];
  const answer = { delayMs: 0, message: "" };
  pool.connect = (async () => {
    connections += 1;
    return {
      on() {},
      removeListener() {},
      release(error?: Error) {
        released.push(error);
      },
      async query(text: string) {
        if (text.startsWith("BEGIN") && connections === 1) {
          await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
          throw new Error(answer.message);
        }
        return { command: text.split(" ")[0], rows: [{ ok: 1 }] };
      },
    };
  }) as unknown as Pool["connect"];
  try {
    // pg fires "Query read timeout" at the pool's query_timeout (statement budget + 2 s).
    Object.assign(answer, { delayMs: 60, message: "Query read timeout" });
    await assert.rejects(withTransaction(pool, (transaction) => transaction.read("SELECT 1")), /Query read timeout/);
    assert.equal(connections, 1, "a timed-out BEGIN is load: sending it again would double it");
    assert.ok(released[0] instanceof Error, "the timed-out client is destroyed, not pooled");

    // A socket that fails at once is still a dead pooled connection: one fresh try.
    connections = 0;
    Object.assign(answer, { delayMs: 0, message: "Connection terminated unexpectedly" });
    const result = await withTransaction(pool, (transaction) => transaction.read("SELECT 1"));
    assert.deepEqual(result.rows, [{ ok: 1 }]);
    assert.equal(connections, 2);
  } finally {
    await pool.end();
  }
});

type ReadOutcome = "dead" | "fatal" | "ok" | "sql";

/** A pool whose Nth lent client answers its first query with outcomes[N]. */
function fakeReadPool(outcomes: readonly ReadOutcome[]) {
  const released: (Error | undefined)[] = [];
  const sent: { text: string; values: unknown[] }[] = [];
  let connections = 0;
  const pool = {
    async connect() {
      const outcome = outcomes[connections];
      connections += 1;
      if (!outcome) throw new Error("timeout exceeded when trying to connect");
      return {
        on() {},
        removeListener() {},
        release(error?: Error) {
          released.push(error);
        },
        async query(config: { text: string; values: unknown[] }) {
          sent.push(config);
          if (outcome === "dead") {
            throw new Error("Connection terminated unexpectedly");
          }
          if (outcome === "sql" || outcome === "fatal") {
            throw Object.assign(new DatabaseError("server says no", 0, "error"), {
              code: outcome === "sql" ? "42P01" : "57P01",
              severity: outcome === "sql" ? "ERROR" : "FATAL",
            });
          }
          return { command: "SELECT", rows: [{ echoed: config.values }] };
        },
      };
    },
  } as unknown as Pool;
  return { connections: () => connections, pool, released, sent };
}

function captureMetrics(): { metrics: Record<string, unknown>[]; restore(): void } {
  const metrics: Record<string, unknown>[] = [];
  const original = console.info;
  console.info = (line: unknown) => void metrics.push(JSON.parse(String(line)));
  return { metrics, restore: () => { console.info = original; } };
}

test("autocommit reads refuse writes and locks before borrowing a connection", async () => {
  const fake = fakeReadPool(["ok"]);
  for (const text of [
    "INSERT INTO mission_control_seasons (season_id) VALUES ('x')",
    "UPDATE mission_control_seasons SET revision = 2",
    "DELETE FROM mission_control_seasons",
    "WITH gone AS (DELETE FROM mission_control_seasons RETURNING *) SELECT * FROM gone",
    "SELECT 1; DELETE FROM mission_control_seasons",
    "SELECT * INTO season_copy FROM mission_control_seasons",
    "SELECT * FROM mission_control_seasons FOR UPDATE",
    "SELECT * FROM mission_control_seasons FOR NO KEY UPDATE",
    "SELECT * FROM mission_control_seasons\n FOR SHARE SKIP LOCKED",
    "SELECT * FROM mission_control_seasons FOR KEY SHARE",
    "SELECT pg_advisory_xact_lock_shared(1)",
    "SELECT pg_try_advisory_lock(1)",
  ]) {
    await assert.rejects(
      autocommitRead(fake.pool, "season", text),
      /only accepts SELECT or SHOW|one statement only|rejects SELECT INTO|cannot take locks/,
      text,
    );
  }
  assert.equal(fake.connections(), 0);
});

test("an autocommit read is one statement, resent once on a fresh client after a dead connection", async () => {
  const fake = fakeReadPool(["dead", "ok"]);
  const capture = captureMetrics();
  try {
    const values = ["season-zero", 7];
    const result = await autocommitRead<{ echoed: unknown[] }>(
      fake.pool,
      "season",
      "SELECT season_id FROM mission_control_seasons WHERE season_id = $1 AND revision = $2",
      values,
      { label: "season.status" },
    );
    assert.deepEqual(result.rows, [{ echoed: ["season-zero", 7] }]);
    assert.notEqual(fake.sent[1]?.values, values, "values are copied");
  } finally {
    capture.restore();
  }
  assert.equal(fake.connections(), 2);
  assert.ok(fake.released[0] instanceof Error, "the dead client is destroyed, not pooled");
  assert.equal(fake.released[1], undefined);
  assert.equal(fake.sent.length, 2, "one statement per attempt: no BEGIN or COMMIT");
  assert.ok(fake.sent.every(({ text }) => text.startsWith("SELECT season_id")));
  for (const metric of capture.metrics) {
    delete metric.at;
    delete metric.durationMs;
  }
  assert.deepEqual(
    capture.metrics,
    [
      { level: 30, metric: "db.read_retry", error: "Error", module: "season" },
      { level: 30, metric: "db.read", attempts: 2, label: "season.status", module: "season", outcome: "ok" },
    ],
  );
});

test("autocommit reads do not resend answers from PostgreSQL, a second dead connection, or a failed checkout", async () => {
  const sql = fakeReadPool(["sql", "ok"]);
  await assert.rejects(autocommitRead(sql.pool, "invitation", "SELECT 1"), { code: "42P01" });
  assert.equal(sql.connections(), 1);
  assert.deepEqual(sql.released, [undefined], "an ERROR ended the implicit transaction; the client is reused");

  const fatal = fakeReadPool(["fatal", "ok"]);
  await assert.rejects(autocommitRead(fatal.pool, "invitation", "SELECT 1"), { code: "57P01" });
  assert.equal(fatal.connections(), 1);
  assert.ok(fatal.released[0] instanceof Error, "a FATAL closed the session; the client is destroyed");

  const dead = fakeReadPool(["dead", "dead", "ok"]);
  await assert.rejects(autocommitRead(dead.pool, "invitation", "SELECT 1"), /terminated/);
  assert.equal(dead.connections(), 2, "one resend at most");
  assert.ok(dead.released.every((error) => error instanceof Error));

  const exhausted = fakeReadPool([]);
  await assert.rejects(autocommitRead(exhausted.pool, "invitation", "SELECT 1"), /when trying to connect/);
  assert.equal(exhausted.connections(), 1, "a pool wait that timed out is load, not a dead socket");
});

test("a transaction can take shorter server-side budgets than its pool, never longer", async () => {
  // Clients whose statements are recorded; BEGIN carries the SET LOCAL budgets.
  function recordingPool(pool: Pool): string[] {
    const statements: string[] = [];
    pool.connect = (async () => ({
      on() {},
      removeListener() {},
      release() {},
      async query(text: string) {
        statements.push(text);
        return { command: text.split(" ")[0], rows: [{ ok: 1 }] };
      },
    })) as unknown as Pool["connect"];
    return statements;
  }
  const runtime = createRuntimePool("postgresql://unused@127.0.0.1:1/unused", {
    ...poolSettingsFromEnvironment({}),
    lockTimeoutMs: 400,
  });
  const sent = recordingPool(runtime);
  try {
    await withTransaction(runtime, (transaction) => transaction.read("SELECT 1"), {
      timeouts: { statementTimeoutMs: 1_000, lockTimeoutMs: 500, idleInTransactionMs: 1_000 },
    });
    await withTransaction(runtime, (transaction) => transaction.read("SELECT 1"));
  } finally {
    await runtime.end();
  }
  assert.deepEqual(sent, [
    // statement_timeout and idle-in-transaction shortened; the pool's 400 ms lock budget kept.
    "BEGIN; SET LOCAL statement_timeout = 1000; SET LOCAL lock_timeout = 400; SET LOCAL idle_in_transaction_session_timeout = 1000",
    "SELECT 1",
    "COMMIT",
    "BEGIN; SET LOCAL statement_timeout = 8000; SET LOCAL lock_timeout = 400; SET LOCAL idle_in_transaction_session_timeout = 15000",
    "SELECT 1",
    "COMMIT",
  ]);

  // A pool without runtime budgets (scripts, tests) gets exactly the given ones.
  const bare = {} as Pool;
  const bareSent = recordingPool(bare);
  await withTransaction(bare, (transaction) => transaction.read("SELECT 1"), {
    timeouts: { statementTimeoutMs: 1_000, lockTimeoutMs: 500 },
  });
  await withTransaction(bare, (transaction) => transaction.read("SELECT 1"));
  assert.deepEqual(bareSent, [
    "BEGIN; SET LOCAL statement_timeout = 1000; SET LOCAL lock_timeout = 500",
    "SELECT 1",
    "COMMIT",
    "BEGIN",
    "SELECT 1",
    "COMMIT",
  ]);
});

test("pool settings have bounded defaults and reject out-of-range values", () => {
  assert.deepEqual(poolSettingsFromEnvironment({}), {
    connectionTimeoutMs: 5_000,
    idleInTransactionMs: 15_000,
    idleTimeoutMs: 10_000,
    lockTimeoutMs: 3_000,
    max: 10,
    statementTimeoutMs: 8_000,
  });
  assert.equal(poolSettingsFromEnvironment({ DATABASE_POOL_MAX: "12" }).max, 12);
  assert.equal(poolSettingsFromEnvironment({ DATABASE_POOL_MAX: "50" }).max, 50);
  assert.throws(() => poolSettingsFromEnvironment({ DATABASE_POOL_MAX: "0" }), /DATABASE_POOL_MAX/);
  assert.throws(() => poolSettingsFromEnvironment({ DATABASE_POOL_MAX: "51" }), /DATABASE_POOL_MAX/);
  assert.throws(() => poolSettingsFromEnvironment({ DATABASE_POOL_MAX: "500" }), /DATABASE_POOL_MAX/);
  assert.throws(
    () => poolSettingsFromEnvironment({ DATABASE_STATEMENT_TIMEOUT_MS: "8s" }),
    /DATABASE_STATEMENT_TIMEOUT_MS/,
  );
});

test("every copy of the pool module in a process shares one pool and its timeouts", async (t) => {
  // Next.js loads this module once per bundle layer; distinct URLs give distinct module copies here.
  const url = new URL("./pool.ts", import.meta.url).href;
  const first = await import(`${url}?copy=1`) as typeof import("@blast/core/modules/database/pool.ts");
  const second = await import(`${url}?copy=2`) as typeof import("@blast/core/modules/database/pool.ts");
  assert.notEqual(first.primaryPool, second.primaryPool, "two module copies");

  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://user:secret@127.0.0.1:9/never_connected";
  const slot = Symbol.for("blast.mission-control.database.pool");
  const pool = first.primaryPool();
  t.after(async () => {
    delete (globalThis as unknown as Record<symbol, unknown>)[slot];
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    await pool.end();
  });

  assert.equal(second.primaryPool(), pool);
  assert.equal(pool.options.max, 10);
  assert.deepEqual(second.transactionTimeoutsFor(pool), first.transactionTimeoutsFor(pool));
  assert.equal(second.transactionTimeoutsFor(pool)?.statementTimeoutMs, 8_000,
    "a copy that did not create the pool still applies its timeouts");
});

test("metric error labels never carry messages", () => {
  assert.equal(errorLabel(sqlError("40001")), "40001");
  assert.equal(errorLabel(new TypeError("secret token abc")), "TypeError");
  assert.equal(errorLabel({ code: "has spaces and secrets" }), "unknown");
  assert.equal(errorLabel("string"), "unknown");
});
