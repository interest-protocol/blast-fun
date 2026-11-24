import { isSuiAddress } from "@blast/core/lib/sui/ids.ts";
import { handleBondingRequest } from "./bonding.ts";
import { publicJson } from "@blast/core/lib/http-errors.ts";
import { CursorError } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { readWalletLaunchesPage } from "@blast/core/modules/launchpad-contract/discovery.ts";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "@blast/core/modules/database/availability.ts";
import { defaultMarketDataDependencies } from "@blast/core/modules/read-routing/blast-infra.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { sectionFromRead } from "@blast/core/modules/launchpad-contract/section.ts";
import { PRIVATE_NO_STORE } from "@blast/server/modules/read-routing/cache-policy.ts";
import { discoveryRow } from "./row.ts";
import { verifiedTeamOf } from "./verified.ts";
import type { WalletLaunchesResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";

/**
 * `GET /api/launchpad/wallets/{address}/launches`: one page of the launches a wallet created,
 * newest first, as the discovery views' display rows, composed over blast-infra's
 * `GET /v1/wallets/{address}/launches` through the validated `/v1` client. It is a reader's own
 * list, read for the wallets their account links, so it is `private, no-store` whatever it holds.
 */

const QUERY_KEYS = ["limit", "cursor", "q"];

function refuse(status: number, code: string, message: string): Response {
  return publicJson(
    { error: { code, message } },
    { status, headers: { "Cache-Control": PRIVATE_NO_STORE } },
  );
}

function unavailable(reason: string, provenance?: Provenance): Response {
  const body: WalletLaunchesResponse = {
    section: {
      state: "unavailable",
      reason,
      retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
      ...(provenance ? { provenance } : {}),
    },
  };
  return publicJson(body, {
    status: 503,
    headers: {
      "Cache-Control": PRIVATE_NO_STORE,
      "Retry-After": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
    },
  });
}

/** This server's blast-infra, or null when it is not configured. */
function configured(): MarketDataDependencies | null {
  try {
    return defaultMarketDataDependencies();
  } catch {
    return null;
  }
}

export async function handleWalletLaunchesRequest(
  request: Request,
  address: string,
  dependencies?: MarketDataDependencies,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const keys = [...params.keys()];
  if (
    !isSuiAddress(address) ||
    keys.length !== new Set(keys).size ||
    keys.some((key) => !QUERY_KEYS.includes(key))
  ) {
    return refuse(
      400,
      "LAUNCHPAD_QUERY_INVALID",
      "Name one wallet by its full address, with only limit and cursor.",
    );
  }
  if (params.has("q"))
    return handleBondingRequest(request, dependencies, address);
  const market = dependencies ?? configured();
  if (!market) return unavailable("unconfigured");
  let read: Awaited<ReturnType<typeof readWalletLaunchesPage>>;
  try {
    read = await readWalletLaunchesPage(
      address,
      { limit: params.get("limit"), cursor: params.get("cursor") },
      market,
    );
  } catch (error) {
    if (error instanceof CursorError)
      return refuse(400, error.code, error.message);
    throw error;
  }
  if (read.status === "unavailable")
    return unavailable(
      read.provenance.reason ?? "unavailable",
      read.provenance,
    );
  if (read.data.kind === "refused") {
    if (read.data.httpStatus === 400) {
      return refuse(
        400,
        "LAUNCHPAD_CURSOR_INVALID",
        "This page of the list cannot be read. Start again from the first page.",
      );
    }
    return unavailable(read.data.error.code, read.provenance);
  }
  const page = read.data.value;
  const rows = page.launches.map(discoveryRow);
  const section = sectionFromRead(
    {
      status: read.status,
      data: { rows, nextCursor: page.nextCursor },
      provenance: read.provenance,
    },
    (data) => data.rows.length === 0,
  );
  const body: WalletLaunchesResponse = { section, ...(await verifiedTeamOf(rows)) };
  return publicJson(body, { headers: { "Cache-Control": PRIVATE_NO_STORE } });
}
