import { createHash } from "node:crypto";
import {
  DatabaseError,
  type Pool,
  type PoolClient,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";

import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import {
  observeAcquire,
  transactionTimeoutsFor,
  type TransactionTimeouts,
} from "./pool.ts";
import {
  DEFAULT_TRANSACTION_RETRY,
  retryTransient,
  type RetryPolicy,
} from "./retry.ts";
import {
  assertChainReadThroughViews,
  assertNoOwnedFunctionCall,
  assertTableOwnership,
  isOwnedTable,
  type MissionControlModule,
  type OwnedTable,
} from "./modules.ts";

export interface ReadableDatabase {
  read<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
    rowMode?: "array",
  ): Promise<QueryResult<Row>>;
}

export interface ModuleTransaction<M extends MissionControlModule>
  extends ReadableDatabase {
  readonly moduleName: M;
  write<Row extends QueryResultRow = QueryResultRow>(
    table: OwnedTable<M>,
    text: string,
    values?: readonly unknown[],
    rowMode?: "array",
  ): Promise<QueryResult<Row>>;
}

export interface TransactionContext extends ReadableDatabase {
  forModule<M extends MissionControlModule>(
    moduleName: M,
  ): ModuleTransaction<M>;
}

function query<Row extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: readonly unknown[] = [],
  rowMode?: "array",
): Promise<QueryResult<Row>> {
  if (!rowMode) return client.query<Row>(text, [...values]);
  const config: QueryConfig<unknown[]> & { rowMode?: "array" } = { text, values: [...values], rowMode };
  return client.query<Row>(config);
}

function assertSingleStatement(text: string): void {
  if (text.includes(";")) {
    throw new Error("Mission Control database operations accept one statement only.");
  }
}

export function assertReadOnlyStatement(text: string): void {
  assertSingleStatement(text);
  if (!/^\s*(SELECT|SHOW)\b/i.test(text)) {
    throw new Error(
      "ReadableDatabase only accepts SELECT or SHOW statements; use an owning module repository for writes.",
    );
  }
  if (/^\s*SELECT\b[\s\S]*\bINTO\s+(?:TEMP(?:ORARY)?\s+)?[a-z_"]/i.test(text)) {
    throw new Error(
      "ReadableDatabase rejects SELECT INTO; use an owning module repository for writes.",
    );
  }
  assertChainReadThroughViews(text);
  assertNoOwnedFunctionCall(text);
}

export function assertOwnedWriteStatement(
  moduleName: MissionControlModule,
  table: string,
  text: string,
): void {
  assertTableOwnership(moduleName, table);
  assertSingleStatement(text);

  const target = writeTarget(text);

  if (target !== table) {
    throw new Error(
      `Mission Control write declared "${table}" but targets "${target ?? "an unsupported statement"}".`,
    );
  }
  assertChainReadThroughViews(text);
}

/**
 * The table a write names, or the schema-qualified function a `SELECT schema.fn(...)` calls: a
 * module may call only a writing function it owns, like a table.
 */
function writeTarget(text: string): string | undefined {
  const target = text.match(
    /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))(?=\s|\(|$)/i,
  );
  const call = text.match(/^\s*SELECT\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*\(/i);
  return target?.[1] ?? target?.[2] ?? call?.[1];
}

/** The owning module must approve the actual table emitted by a query builder. */
export function ownedWriteTarget<M extends MissionControlModule>(moduleName: M, text: string): OwnedTable<M> {
  assertSingleStatement(text);
  const target = writeTarget(text);
  if (!target || !isOwnedTable(moduleName, target)) {
    throw new Error(`Mission Control module "${moduleName}" cannot write table "${target ?? "an unsupported statement"}".`);
  }
  return target;
}

function read<Row extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values?: readonly unknown[],
  rowMode?: "array",
): Promise<QueryResult<Row>> {
  assertReadOnlyStatement(text);
  return query<Row>(client, text, values, rowMode);
}

function createTransactionContext(client: PoolClient, signal?: AbortSignal): TransactionContext {
  const checked = <T>(run: () => T): T => { signal?.throwIfAborted(); return run(); };
  return {
    read: (text, values, rowMode) => checked(() => read(client, text, values, rowMode)),
    forModule: <M extends MissionControlModule>(moduleName: M) => ({
      moduleName,
      read: (text, values, rowMode) => checked(() => read(client, text, values, rowMode)),
      write: <Row extends QueryResultRow>(
        table: OwnedTable<M>,
        text: string,
        values?: readonly unknown[],
        rowMode?: "array",
      ) => {
        signal?.throwIfAborted();
        assertOwnedWriteStatement(moduleName, table, text);
        return query<Row>(client, text, values, rowMode);
      },
    }),
  };
}

export type IsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export type TransactionOptions = Readonly<{
  isolationLevel?: IsolationLevel;
  /** Whole-operation cancellation, including checkout and COMMIT; destroys a lent client. */
  signal?: AbortSignal;
  /** Names the transaction in `db.transaction` metrics. Unlabelled ones are not reported. */
  label?: string;
  /**
   * Re-run the whole operation after a serialization failure, deadlock, or lock
   * timeout. Only for operations whose side effects are all inside this
   * transaction: no provider calls, no reliance on state from an earlier attempt.
   */
  retry?: boolean | RetryPolicy;
  /**
   * Server-side budgets shorter than the pool's, set with SET LOCAL like the
   * pool's own, for optional work (telemetry) that must end on the server
   * within a bound. Each value is the lower of this and the pool's; on a pool
   * without runtime budgets only the given ones are set. A statement that
   * runs into one fails and the transaction rolls back: nothing commits later.
   */
  timeouts?: Partial<TransactionTimeouts>;
}>;

function lower(pool: number | undefined, requested: number | undefined): number | undefined {
  if (requested === undefined) return pool;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new TypeError("Transaction budgets must be positive integers.");
  }
  return pool === undefined ? requested : Math.min(pool, requested);
}

function effectiveTimeouts(
  pool: TransactionTimeouts | undefined,
  requested: Partial<TransactionTimeouts> | undefined,
): Partial<TransactionTimeouts> {
  return {
    statementTimeoutMs: lower(pool?.statementTimeoutMs, requested?.statementTimeoutMs),
    lockTimeoutMs: lower(pool?.lockTimeoutMs, requested?.lockTimeoutMs),
    idleInTransactionMs: lower(pool?.idleInTransactionMs, requested?.idleInTransactionMs),
  };
}

function beginStatement(
  timeouts: Partial<TransactionTimeouts>,
  isolationLevel: IsolationLevel | undefined,
): string {
  const statements = [
    isolationLevel ? `BEGIN ISOLATION LEVEL ${isolationLevel}` : "BEGIN",
  ];
  // SET LOCAL survives transaction-mode poolers (Neon's PgBouncer), which drop
  // session settings and startup options. One round trip with BEGIN.
  if (timeouts.statementTimeoutMs !== undefined) {
    statements.push(`SET LOCAL statement_timeout = ${timeouts.statementTimeoutMs}`);
  }
  if (timeouts.lockTimeoutMs !== undefined) {
    statements.push(`SET LOCAL lock_timeout = ${timeouts.lockTimeoutMs}`);
  }
  if (timeouts.idleInTransactionMs !== undefined) {
    statements.push(
      `SET LOCAL idle_in_transaction_session_timeout = ${timeouts.idleInTransactionMs}`,
    );
  }
  return statements.join("; ");
}

// pg-pool detaches its idle 'error' listener while a client is lent out. A
// backend that dies between statements (idle_in_transaction timeout, a Neon
// restart, a pooler reset) makes pg emit 'error' with no active query; without
// a listener that is an uncaught exception that takes down the whole instance.
// The failed query or COMMIT still rejects to the caller.
function onLentClientError(error: Error): void {
  recordMetric("db.client_error", { error: errorLabel(error) });
}

const lentAborts = new WeakMap<PoolClient, { signal: AbortSignal; abort: () => void; released: boolean }>();

async function checkout(pool: Pool, signal?: AbortSignal): Promise<PoolClient> {
  const acquireStarted = performance.now();
  let client: PoolClient;
  try {
    signal?.throwIfAborted();
    client = signal ? await new Promise<PoolClient>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void pool.connect().then((acquired) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) { acquired.release(); reject(signal.reason); }
        else resolve(acquired);
      }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
      if (signal.aborted) abort();
    }) : await pool.connect();
    if (signal?.aborted) {
      client.release();
      signal.throwIfAborted();
    }
  } catch (error) {
    observeAcquire(pool, performance.now() - acquireStarted, error);
    throw error;
  }
  observeAcquire(pool, performance.now() - acquireStarted);
  client.on("error", onLentClientError);
  if (signal) {
    const owner = { signal, released: false, abort: () => {
      owner.released = true;
      client.release(new Error("Transaction operation cancelled."));
    } };
    lentAborts.set(client, owner);
    signal.addEventListener("abort", owner.abort, { once: true });
    if (signal.aborted) owner.abort();
  }
  return client;
}

/** Returns the client; an error destroys it instead of pooling it. */
function giveBack(client: PoolClient, error?: Error): void {
  const owner = lentAborts.get(client);
  if (owner) {
    owner.signal.removeEventListener("abort", owner.abort);
    lentAborts.delete(client);
  }
  client.removeListener("error", onLentClientError);
  if (!owner?.released) client.release(error);
}

/** An error without a SQLSTATE came from the socket, not from PostgreSQL. */
function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return !(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code));
}

async function begin(
  pool: Pool,
  isolationLevel: IsolationLevel | undefined,
  requested: Partial<TransactionTimeouts> | undefined,
  signal?: AbortSignal,
): Promise<PoolClient> {
  const timeouts = transactionTimeoutsFor(pool);
  const statement = beginStatement(effectiveTimeouts(timeouts, requested), isolationLevel);
  for (let attempt = 1; ; attempt += 1) {
    const client = await checkout(pool, signal);
    const started = performance.now();
    try {
      signal?.throwIfAborted();
      await client.query(statement);
      signal?.throwIfAborted();
      return client;
    } catch (error) {
      // pg-pool does not test idle clients before lending them, and Neon
      // closes idle server connections. Nothing has run yet, so one fresh
      // client is a safe second try. A BEGIN that ran into the pool's
      // client-side query timeout ("Query read timeout", no SQLSTATE) met a
      // saturated pooler, not a dead socket: resending it would double the
      // load, as in `autocommit`.
      giveBack(client, error instanceof Error ? error : new Error("BEGIN failed"));
      const timedOut = timeouts !== undefined &&
        performance.now() - started >= timeouts.statementTimeoutMs;
      if (signal?.aborted || attempt >= 2 || timedOut || !isConnectionError(error)) throw error;
      recordMetric("db.begin_retry", { error: errorLabel(error) });
    }
  }
}

async function runOnce<Result>(
  pool: Pool,
  operation: (transaction: TransactionContext) => Promise<Result>,
  isolationLevel: IsolationLevel | undefined,
  requested: Partial<TransactionTimeouts> | undefined,
  signal?: AbortSignal,
): Promise<Result> {
  const client = await begin(pool, isolationLevel, requested, signal);
  let releaseError: Error | undefined;
  try {
    const result = await operation(createTransactionContext(client, signal));
    signal?.throwIfAborted();
    const committed = await client.query("COMMIT");
    // COMMIT on an aborted transaction succeeds with a ROLLBACK tag.
    if (committed.command !== "COMMIT") {
      throw new Error(`Transaction ended with ${committed.command} instead of COMMIT.`);
    }
    return result;
  } catch (error) {
    try {
      if (!signal?.aborted) await client.query("ROLLBACK");
    } catch (rollbackError) {
      // A client that cannot roll back is broken; destroy it instead of
      // returning it to the pool with an open transaction.
      releaseError = rollbackError instanceof Error ? rollbackError : new Error("ROLLBACK failed");
    }
    throw error;
  } finally {
    giveBack(client, releaseError);
  }
}

export async function withTransaction<Result>(
  pool: Pool,
  operation: (transaction: TransactionContext) => Promise<Result>,
  options: TransactionOptions = {},
): Promise<Result> {
  const policy =
    options.retry === true
      ? DEFAULT_TRANSACTION_RETRY
      : options.retry || { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 };
  const started = performance.now();
  let attempts = 0;
  try {
    const result = await retryTransient(
      (attempt) => {
        attempts = attempt;
        return runOnce(pool, operation, options.isolationLevel, options.timeouts, options.signal);
      },
      policy,
    );
    if (options.label) {
      recordMetric("db.transaction", {
        attempts,
        durationMs: Math.round(performance.now() - started),
        label: options.label,
        outcome: "ok",
      });
    }
    return result;
  } catch (error) {
    if (options.label) {
      recordMetric("db.transaction", {
        attempts,
        durationMs: Math.round(performance.now() - started),
        error: errorLabel(error),
        label: options.label,
        outcome: "error",
      });
    }
    throw error;
  }
}

class ReadBatchCompletionError extends Error {}

function committedReadResult<Row extends QueryResultRow>(results: QueryResult<Row> | QueryResult<Row>[]): QueryResult<Row> {
  const result = Array.isArray(results) ? results.at(-2) : undefined;
  if (!Array.isArray(results) || results.at(-1)?.command !== "COMMIT" || !result || !["SELECT", "SHOW"].includes(result.command)) {
    throw new ReadBatchCompletionError("Read-only batch did not finish with a read and COMMIT.");
  }
  return result;
}

async function runReadBatch<Row extends QueryResultRow>(client: PoolClient, batch: string): Promise<QueryResult<Row>> {
  let releaseError: Error | undefined;
  try {
    return committedReadResult(await client.query<Row>(batch));
  } catch (error) {
    if (!(error instanceof DatabaseError) || error.severity === "FATAL" || error.severity === "PANIC") {
      releaseError = error instanceof Error ? error : new Error("Read-only batch failed.");
    } else {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { releaseError = rollbackError instanceof Error ? rollbackError : new Error("ROLLBACK failed."); }
    }
    throw error;
  } finally { giveBack(client, releaseError); }
}

/**
 * One read-only transaction in one simple-query exchange, retaining SET LOCAL
 * budgets through transaction-mode poolers. Only static SELECT/SHOW SQL; callers
 * must encode data as hex literals, never concatenate raw input. No parameters
 * or prepared statements: PostgreSQL extended queries cannot contain a batch.
 * The read result is returned only after COMMIT and ReadyForQuery. A failed
 * batch stops before COMMIT, so rollback (or destruction) is mandatory.
 */
export async function batchedRead<Row extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  moduleName: MissionControlModule,
  text: string,
  options: Pick<TransactionOptions, "label" | "timeouts"> = {},
): Promise<QueryResult<Row>> {
  assertReadOnlyStatement(text);
  if (/\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b|\bpg_(?:try_)?advisory/i.test(text)) {
    throw new Error("Batched reads cannot retain locks; lock inside withTransaction.");
  }
  const timeouts = effectiveTimeouts(transactionTimeoutsFor(pool), options.timeouts);
  const batch = `${beginStatement(timeouts, undefined).replace("BEGIN", "BEGIN READ ONLY")}; ${text}; COMMIT`;
  const started = performance.now();
  let attempts = 0;
  const report = (outcome: string, error?: unknown) => {
    if (options.label) recordMetric("db.transaction", {
      attempts, durationMs: Math.round(performance.now() - started), label: options.label,
      module: moduleName, outcome, ...(error ? { error: errorLabel(error) } : {}),
    });
  };
  try {
    for (;;) {
      attempts += 1;
      const client = await checkout(pool);
      const queryStarted = performance.now();
      try {
        const result = await runReadBatch<Row>(client, batch);
        report("ok");
        return result;
      } catch (error) {
        const timedOut = timeouts.statementTimeoutMs !== undefined && performance.now() - queryStarted >= timeouts.statementTimeoutMs;
        const clientTimedOut = error instanceof Error && error.message === "Query read timeout";
        if (attempts >= 2 || timedOut || clientTimedOut || error instanceof ReadBatchCompletionError || !isConnectionError(error)) throw error;
        recordMetric("db.read_retry", { error: errorLabel(error), module: moduleName });
      }
    }
  } catch (error) { report("error", error); throw error; }
}

/**
 * Sends one statement with no BEGIN or COMMIT: one round trip.
 *
 * Timeouts: an autocommit statement has no transaction for SET LOCAL, and a
 * session SET or startup option would leak through (or be refused by) Neon's
 * transaction pooler. The pool's statement budget is therefore enforced on the
 * client with pg's per-query `query_timeout`. When it fires the statement may
 * still be running on the server (its outcome is unknown, as with any lost
 * connection), so that connection is destroyed rather than returned to the
 * pool. A server-reported error (a pg `DatabaseError`) has already ended the
 * implicit transaction, so that connection is reused, unless the server also
 * closed the session (FATAL, for example a terminated backend).
 * Pools without runtime timeouts (scripts, tests) run without a limit, as in
 * `withTransaction`.
 *
 * `onRetry` makes a statement that failed on a dead connection go once more
 * on a fresh client, as `begin()` does. Only side-effect-free statements may
 * pass it. A failure to get a client (the pool's wait limit) and a statement
 * that ran into its budget are never retried: both are load, and repeating
 * them would double it.
 */
async function autocommit<Row extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[],
  onRetry?: (error: unknown) => void,
  rowMode?: "array",
  preparedName?: string,
): Promise<QueryResult<Row>> {
  const timeoutMs = transactionTimeoutsFor(pool)?.statementTimeoutMs;
  const config: QueryConfig<unknown[]> & { query_timeout?: number; rowMode?: "array" } = {
    text,
    values: [...values],
    rowMode,
    name: preparedName,
    ...(timeoutMs ? { query_timeout: timeoutMs } : {}),
  };
  for (let attempt = 1; ; attempt += 1) {
    const client = await checkout(pool);
    const started = performance.now();
    let releaseError: Error | undefined;
    try {
      return await client.query<Row, unknown[]>(config);
    } catch (error) {
      if (!(error instanceof DatabaseError) || error.severity === "FATAL" || error.severity === "PANIC") {
        releaseError = error instanceof Error ? error : new Error("Autocommit statement failed.");
      }
      const timedOut = timeoutMs !== undefined && performance.now() - started >= timeoutMs;
      if (!onRetry || attempt >= 2 || timedOut || !isConnectionError(error)) throw error;
      onRetry(error);
    } finally {
      giveBack(client, releaseError);
    }
  }
}

/**
 * Runs one owned write as its own autocommit statement: no BEGIN or COMMIT,
 * one round trip. Only for a write that is complete on its own; anything that
 * must commit together with another statement belongs in `withTransaction`.
 * Timeouts and connection handling are those of `autocommit` above. A write
 * is never retried: after a lost connection its outcome is unknown.
 */
export async function autocommitWrite<
  M extends MissionControlModule,
  Row extends QueryResultRow = QueryResultRow,
>(
  pool: Pool,
  moduleName: M,
  table: OwnedTable<M>,
  text: string,
  values: readonly unknown[] = [],
  rowMode?: "array",
): Promise<QueryResult<Row>> {
  assertOwnedWriteStatement(moduleName, table, text);
  return autocommit<Row>(pool, text, values, undefined, rowMode);
}

export type AutocommitReadOptions = Readonly<{
  rowMode?: "array";
  /** Only for a bounded set of static SQL shapes; requires protocol prepared-statement support (Neon supports it). */
  prepare?: boolean;
  /** Names the read in `db.read` metrics. Unlabelled ones are not reported. */
  label?: string;
}>;

/**
 * Runs one SELECT or SHOW as its own autocommit statement: one round trip
 * instead of three (BEGIN with the SET LOCAL timeouts, the read, COMMIT). At
 * READ COMMITTED every statement takes its own snapshot even inside a
 * transaction, so a lone read sees exactly what it would have seen there.
 * What it gives up is the SET LOCAL lock and idle-in-transaction timeouts, the
 * trade `autocommitWrite` already makes; the statement budget still applies
 * on the client (see `autocommit`). Row locks and advisory locks are refused
 * because they would end with the statement: they belong in `withTransaction`.
 *
 * Only for a read that stands alone. Reads that must agree with each other,
 * or whose answer decides a write, stay in one transaction.
 *
 * A read has no side effects, so one that fails on a dead connection (pg-pool
 * lends idle clients untested, and Neon closes idle server connections) is
 * sent once more on a fresh client.
 */
export async function autocommitRead<Row extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  moduleName: MissionControlModule,
  text: string,
  values: readonly unknown[] = [],
  options: AutocommitReadOptions = {},
): Promise<QueryResult<Row>> {
  assertReadOnlyStatement(text);
  if (/\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b|\bpg_(?:try_)?advisory/i.test(text)) {
    throw new Error("Autocommit reads cannot take locks; lock inside withTransaction.");
  }
  const started = performance.now();
  let attempts = 1;
  const report = (fields: Readonly<Record<string, string>>) => {
    if (!options.label) return;
    recordMetric("db.read", {
      attempts,
      durationMs: Math.round(performance.now() - started),
      label: options.label,
      module: moduleName,
      ...fields,
    });
  };
  try {
    const result = await autocommit<Row>(pool, text, values, (error) => {
      attempts += 1;
      recordMetric("db.read_retry", { error: errorLabel(error), module: moduleName });
    }, options.rowMode, options.prepare ? `blast_${createHash("sha256").update(text).digest("base64url")}` : undefined);
    report({ outcome: "ok" });
    return result;
  } catch (error) {
    report({ error: errorLabel(error), outcome: "error" });
    throw error;
  }
}

/**
 * A `ReadableDatabase` whose every read is its own `autocommitRead`, for
 * repository methods that make exactly one read. Two reads through it are two
 * transactions, possibly on two connections.
 */
export function autocommitReader(
  pool: Pool,
  moduleName: MissionControlModule,
  options: AutocommitReadOptions = {},
): ReadableDatabase {
  return {
    read: (text, values, rowMode) => autocommitRead(pool, moduleName, text, values, { ...options, rowMode: rowMode ?? options.rowMode }),
  };
}
