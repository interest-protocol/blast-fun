import { errorLabel, observeMetric } from "@blast/core/lib/metrics.ts";
import { DISCOVERY_PAGE, readDiscoveryPage, type DiscoveryPage } from "@blast/core/modules/launchpad-contract/discovery.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import type { V1Answer } from "@blast/core/modules/launchpad-contract/v1.ts";
import { defaultMarketDataDependencies } from "@blast/core/modules/read-routing/blast-infra.ts";

/** A graduated curve's raise target in quote atoms, by launch id. */
export type CurveTargets = (launchIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;

type ReadPage = (cursor: string | null) => Promise<RoutedRead<V1Answer<DiscoveryPage>>>;

/** blast-infra re-reads at most this often, and only for a launch the process has not seen. */
export const CURVE_TARGET_REFRESH_MS = 60_000;
/** A Home read waits at most this long for a walk in flight; the walk goes on without it. */
export const CURVE_TARGET_WAIT_MS = 500;
const MAX_PAGES = 50;

const graduatedPage: ReadPage = (cursor) =>
  readDiscoveryPage("graduated", { limit: String(DISCOVERY_PAGE.max), cursor }, defaultMarketDataDependencies());

/**
 * The raise targets of graduated curves, from blast-infra's `graduated`
 * discovery view (newest graduation first). A target never changes, so the
 * process keeps every one it has read. A launch it has not seen (a curve
 * still bonding stays unseen) pages the view again from the newest, at most
 * once per `CURVE_TARGET_REFRESH_MS`, stopping at the first page with a
 * launch it knew once one walk has finished. A walk keeps its targets only
 * when it finishes, so a failed page never leaves a gap behind a known launch.
 * Past `MAX_PAGES` the oldest launches stay unknown.
 * Unknown is not dust (`isBlastDust`). Only the first walk holds a Home
 * read, for at most `CURVE_TARGET_WAIT_MS`; later walks (a bonding curve is
 * always unseen, so one starts every interval) run behind the reads, and a
 * newly graduated launch counts from the next read after its walk.
 */
export function createCurveTargetReader(
  readPage: ReadPage = graduatedPage,
  now: () => number = Date.now,
  waitMs = CURVE_TARGET_WAIT_MS,
): CurveTargets {
  const known = new Map<string, string>();
  let lastLoadMs = -Infinity;
  let finished = false;
  let loading: Promise<void> | null = null;

  async function load(): Promise<void> {
    const found = new Map<string, string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const read = await readPage(cursor);
      if (read.status === "unavailable" || read.data.kind !== "answer") throw new Error(`graduated page ${read.status === "unavailable" ? "unavailable" : read.data.kind}`);
      const { launches, nextCursor } = read.data.value;
      for (const launch of launches) {
        const target = launch.economics.inputs.graduationTarget;
        if (target !== null) found.set(launch.launchId, target.toString());
      }
      if (nextCursor === null || (finished && launches.some((launch) => known.has(launch.launchId)))) break;
      cursor = nextCursor;
    }
    for (const [id, target] of found) known.set(id, target);
    finished = true;
  }

  return async (launchIds) => {
    if (!launchIds.some((id) => !known.has(id))) return known;
    if (!loading && now() - lastLoadMs >= CURVE_TARGET_REFRESH_MS) {
      lastLoadMs = now();
      loading = load().catch((error: unknown) => {
        observeMetric("social.source", { source: "home_curve_targets", outcome: "unavailable", error: errorLabel(error) });
      }).finally(() => { loading = null; });
    }
    if (loading && !finished) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([loading, new Promise((resolve) => { timer = setTimeout(resolve, waitMs); })]);
      clearTimeout(timer);
    }
    return known;
  };
}
