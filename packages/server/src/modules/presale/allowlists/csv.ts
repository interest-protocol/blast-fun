import type { Pool } from "pg";

import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { isSuiAddress } from "@blast/core/lib/sui/ids.ts";
import { PRESALE_ALLOWLIST_CSV_READ } from "@blast/core/modules/backend-api/public-read-routes.ts";

import { findAllowlistCsv } from "./bindings.ts";
import type { PresaleEligibilityReader } from "./eligibility.ts";

type Dependencies = Readonly<{
  pool: () => Pool;
  eligibility: (presaleId: string, signal: AbortSignal) => ReturnType<PresaleEligibilityReader>;
}>;

export function createAllowlistCsvRead({ pool: getPool, eligibility }: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const presaleId = routeSegments(PRESALE_ALLOWLIST_CSV_READ.path, url.pathname)?.presale_id;
    if (!isSuiAddress(presaleId) || url.search) {
      return publicErrorResponse("invalid_parameter", "Provide a presale ID without query parameters.", 400);
    }

    const pool = getPool();
    let csv = await findAllowlistCsv(pool, presaleId);
    if (csv === null) {
      const policy = await eligibility(presaleId, request.signal);
      if (policy?.kind === "allowlisted" && policy.leafCount <= 65_536n) {
        csv = await findAllowlistCsv(pool, presaleId, policy);
      }
    }
    if (csv === null) {
      return publicErrorResponse("allowlist_not_found", "Blast has no allowlist for this presale.", 404);
    }

    return new Response(`wallet,cap\r\n${csv}\r\n`, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="allowlist-${presaleId}.csv"`,
        "Content-Type": "text/csv; charset=utf-8",
      },
    });
  };
}
