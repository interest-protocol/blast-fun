import { CursorError } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { readClassifiedActivity, readCurveFlow, type ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import type { V1Answer } from "@blast/core/modules/launchpad-contract/v1.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";

import type { FlowOutcome, PageOutcome } from "./activity-model";

/**
 * The Activity destination's reads in the browser, blast-infra's `/v1`
 * answers relayed by this app's `/api/launchpad/market` routes, through the
 * validated client (`browser-activity.ts`):
 * the launch's classified activity (the venue pool's swaps after migration
 * included) and the curve summary's windowed flow. A starting, unreachable, lagging-beyond-use or
 * refusing engine is a failed read with its reason, never an empty list.
 */

function outcome<T, Row>(
  read: RoutedRead<V1Answer<T>>,
  rows: (value: T) => Readonly<{ rows: readonly Row[]; next: string | null }>,
): PageOutcome<Row> {
  if (read.status === "unavailable") return { kind: "failed", reason: read.provenance.reason ?? "unavailable" };
  if (read.data.kind === "refused") return { kind: "failed", reason: read.data.error.code };
  return { kind: "rows", ...rows(read.data.value), provenance: read.provenance, lagging: read.status === "stale" };
}

async function guarded<T>(read: () => Promise<T>): Promise<T | Readonly<{ kind: "failed"; reason: string }>> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CursorError) return { kind: "failed", reason: "invalid_parameter" };
    throw error;
  }
}

/** The classified activity page after `cursor` (the newest when null). */
export async function readActivityPage(
  launchId: string,
  cursor: string | null,
  dependencies: MarketDataDependencies,
): Promise<PageOutcome<ActivityRow>> {
  return guarded(async () =>
    outcome(await readClassifiedActivity(launchId, { cursor, walletLabels: true }, dependencies), (page) => ({ rows: page.activity, next: page.nextCursor })),
  );
}

/** The curve summary's windowed flow. */
export async function readFlow(launchId: string, dependencies: MarketDataDependencies): Promise<FlowOutcome> {
  return guarded(async () => {
    const read = await readCurveFlow(launchId, dependencies);
    if (read.status === "unavailable") return { kind: "failed", reason: read.provenance.reason ?? "unavailable" } as const;
    if (read.data.kind === "refused") return { kind: "failed", reason: read.data.error.code } as const;
    return { kind: "flow", flow: read.data.value, provenance: read.provenance, lagging: read.status === "stale" } as const;
  });
}
