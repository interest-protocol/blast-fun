import { databaseErrorCause, isTransientDatabaseError } from "./retry.ts";

/**
 * `Retry-After` (seconds) on a claim-path 503. The onboarding client waits
 * this long, plus up to a second of jitter, before its bounded retry.
 */
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** pg and pg-pool raise these, without a SQLSTATE, when no usable connection exists. */
const CONNECTION_FAILURE_MESSAGES = new Set([
  // pg-pool: no free client within connectionTimeoutMillis.
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
  "Connection terminated unexpectedly",
  "Connection terminated",
  // pg: the client-side query_timeout fired.
  "Query read timeout",
  "timeout expired",
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
]);

const SOCKET_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * SQLSTATE classes that mean "not now" rather than "wrong": 08 connection
 * exception, 53 insufficient resources (53300 too_many_connections), 57
 * operator intervention (57014 statement_timeout, 57P01 admin shutdown,
 * 57P03 cannot connect now).
 */
const UNAVAILABLE_SQLSTATE_CLASSES = new Set(["08", "53", "57"]);

/**
 * True when the database could not serve the request right now: no free pool
 * connection, a lost or refused connection, a statement, lock or
 * idle-in-transaction timeout, or contention that outlasted its retries. Such
 * a failure is backpressure (503 with Retry-After). Everything else,
 * constraint violations and programming errors included, is false.
 */
export function isDatabaseUnavailableError(error: unknown): boolean {
  error = databaseErrorCause(error);
  if (isTransientDatabaseError(error)) return true;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    if (SOCKET_ERROR_CODES.has(code)) return true;
    if (/^[0-9A-Z]{5}$/.test(code)) {
      return code === "25P03" || UNAVAILABLE_SQLSTATE_CLASSES.has(code.slice(0, 2));
    }
  }
  return error instanceof Error && CONNECTION_FAILURE_MESSAGES.has(error.message);
}
