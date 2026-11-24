import { createHash } from "node:crypto";
import { Pool } from "pg";

/** Mirrors node-postgres effective-host semantics, including empty query host. */
export function accessDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || url.searchParams.has("options"))
      throw new Error();
    const host =
      url.searchParams.get("host") || decodeURIComponent(url.hostname);
    const local =
      host.startsWith("/") ||
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
    if (
      host.toLowerCase().includes("-pooler.") ||
      (!local && url.searchParams.get("sslmode") !== "verify-full")
    )
      throw new Error();
    // Prevent driver options that change TLS verification, or connection time bounds.
    const allowed = new Set([
      "host",
      "port",
      "user",
      "password",
      "dbname",
      "sslmode",
      "sslrootcert",
      "sslcert",
      "sslkey",
      "application_name",
    ]);
    if (keys.some((key) => !allowed.has(key))) throw new Error();
    return url.toString();
  } catch {
    throw new Error("Invalid access database");
  }
}

export function createAccessRedeemer(value: string) {
  const pool = new Pool({
    connectionString: accessDatabaseUrl(value),
    max: 1,
    connectionTimeoutMillis: 750,
    statement_timeout: 750,
    query_timeout: 1000,
    idleTimeoutMillis: 10_000,
    idle_in_transaction_session_timeout: 1000,
    application_name: "analytics-access",
    options: "-c lock_timeout=250 -c max_parallel_workers_per_gather=0",
  });
  pool.on("error", () => {});
  return {
    async redeem(code: string): Promise<string | null> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
      if (pool.waitingCount >= 2) throw new Error("Access unavailable");
      const hash = createHash("sha256").update(code).digest("hex");
      try {
        const result = await pool.query<{ accepted: boolean }>(
          "SELECT blast_analytics.redeem_access_code($1) AS accepted",
          [hash],
        );
        return result.rows[0]?.accepted === true ? hash : null;
      } catch {
        throw new Error("Access unavailable");
      }
    },
    close: () => pool.end(),
  };
}
