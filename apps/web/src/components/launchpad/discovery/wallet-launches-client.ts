import { gatedFetch } from "#web/lib/api-gate-client.ts";
import {
  parseWalletLaunchesResponse,
  type WalletLaunchesResponse,
} from "@blast/core/modules/launchpad-discovery/rows.ts";

import { RAIL_PAGE_SIZE } from "./discovery-model";

/** The wallet launches resource's URL for the page after `cursor` (null: the first page). */
export function walletLaunchesUrl(
  address: string,
  cursor: string | null,
  search?: string,
): string {
  const query = new URLSearchParams({ limit: String(RAIL_PAGE_SIZE) });
  if (search !== undefined) query.set("q", search);
  if (cursor) query.set("cursor", cursor);
  return `/api/launchpad/wallets/${address}/launches?${query.toString()}`;
}

/**
 * One page of the launches `address` created, from `/api/launchpad/wallets/{address}/launches`;
 * null when the request did not complete or was refused. The answer is the reader's own
 * (`private, no-store`), and the read bypasses the browser's HTTP cache so Refresh and Load more
 * reach the server.
 */
export async function readWalletLaunchesPage(
  address: string,
  cursor: string | null,
  fetcher: typeof fetch = gatedFetch,
  search?: string,
  signal?: AbortSignal,
): Promise<WalletLaunchesResponse | null> {
  try {
    const response = await fetcher(walletLaunchesUrl(address, cursor, search), {
      signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    // A refused address or page token (400) carries no section.
    if (response.status === 400) return null;
    return parseWalletLaunchesResponse(await response.json());
  } catch {
    return null;
  }
}
