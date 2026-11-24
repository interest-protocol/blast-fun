import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { processSingleton } from "../../lib/process-singleton.ts";
import { DEFILLAMA_READ_POOL_MAX, type Profile } from "./contracts.ts";
import { reportingReads } from "./store.ts";

if (typeof window !== "undefined") {
  throw new Error("DefiLlama reporting is server-only");
}

/**
 * The reporting reads over `DEFILLAMA_READ_DATABASE_URL` with the published
 * profile, both parsed and checked once at boot by the caller. Null settings
 * (no reporting database) throw.
 */
export type DefillamaSettings = Readonly<{ url: string; profile: Profile }>;

export function defillamaReportingReads(settings: DefillamaSettings | null) {
  return processSingleton("defillama.reporting-reads", () => {
    if (!settings) {
      throw new Error("DEFILLAMA_READ_DATABASE_URL is required");
    }
    const { url, profile } = settings;
    const pool = new Pool({
      connectionString: url,
      max: DEFILLAMA_READ_POOL_MAX,
      connectionTimeoutMillis: 1000,
      query_timeout: 1500,
      idleTimeoutMillis: 10_000,
      application_name: "blast-defillama-read",
      options: "-c default_transaction_read_only=on -c statement_timeout=1000",
    });
    pool.on("error", () => {
      console.error("DefiLlama reporting connection unavailable");
    });
    attachDatabasePool(pool);
    return reportingReads(pool, profile);
  });
}
