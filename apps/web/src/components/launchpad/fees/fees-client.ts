import { CursorError, readLaunchRewards } from "#web/modules/launchpad-contract/browser-rewards.ts";
import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";

import type { FeeUnits } from "./FeesView";
import { feesOutcome, type FeesOutcome } from "./fees-model";

/**
 * Which launch's fees the browser reads (through this app's `/api/launchpad/market` route,
 * never blast-infra itself), for the deployment this page serves, and the units it shows them
 * in. Nothing here is secret; the server hands it to the page.
 */
export type FeesSource = Readonly<{
  launchId: string;
  /** The deployment the page serves; answers about another are Unavailable. Null checks nothing. */
  expected: ExpectedDeployment | null;
  units: FeeUnits;
}>;

/** The launch's fees, as the section takes them. */
export async function readFees(source: FeesSource, dependencies: MarketDataDependencies): Promise<FeesOutcome> {
  try {
    return feesOutcome(await readLaunchRewards(source.launchId, dependencies));
  } catch (error) {
    if (error instanceof CursorError) return { kind: "failed", reason: "invalid_parameter" };
    throw error;
  }
}
