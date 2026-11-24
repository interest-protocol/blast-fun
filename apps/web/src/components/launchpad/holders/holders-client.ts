import { CursorError, readHoldersSnapshot } from "#web/modules/launchpad-contract/browser-holders.ts";
import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";

import { holdersOutcome, type HoldersOutcome } from "./holders-model";

/**
 * Which coin's native holder snapshot the browser reads (through this app's
 * `/api/launchpad/market` route, never blast-infra itself), for the
 * deployment this page serves. Nothing here is secret; the server hands it
 * to the page.
 */
export type HoldersSource = Readonly<{
  launchId: string;
  coinType: string;
  /** The deployment the page serves; answers about another are Unavailable. Null checks nothing. */
  expected: ExpectedDeployment | null;
  symbol: string;
  /** The coin's decimals; null shows balances in atoms. */
  decimals: number | null;
}>;

/** One snapshot page after `cursor` (the first when null), as the holders view takes it. */
export async function readHoldersPage(
  source: HoldersSource,
  cursor: string | null,
  dependencies: MarketDataDependencies,
): Promise<HoldersOutcome> {
  try {
    return holdersOutcome(await readHoldersSnapshot(source.coinType, source.launchId, { cursor }, dependencies));
  } catch (error) {
    if (error instanceof CursorError) return { kind: "failed", reason: "invalid_parameter" };
    throw error;
  }
}
