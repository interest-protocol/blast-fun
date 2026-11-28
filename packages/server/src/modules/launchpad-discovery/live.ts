import { parseBondingPage } from "@blast/core/modules/launchpad-contract/bonding.ts";
import { parseDiscoveryPage } from "@blast/core/modules/launchpad-contract/discovery.ts";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";
import { almostGraduated, type BondingLiveView, type DiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { discoveryRow, isPublicLaunch } from "./row.ts";

/** Convert a committed reader snapshot to the same public rows and cursor as HTTP. */
export function projectDiscovery(frame: Readonly<Record<string, unknown>>, provenance: Provenance): readonly DiscoveryResponse[] {
  const newPage = parseDiscoveryPage("new", frame.new);
  const progress = parseBondingPage({ stage: "bonding", sort: "progress", q: "" }, frame.progress);
  const page = (view: BondingLiveView, source: typeof newPage): DiscoveryResponse => {
    const rows = source.launches.filter(isPublicLaunch).map(discoveryRow);
    const nextCursor = source.nextCursor;
    return {
      view,
      section: rows.length || nextCursor
        ? { state: "available", provenance, data: { rows, nextCursor } }
        : { state: "empty", provenance },
    };
  };
  return [page("new", newPage), almostGraduated(page("near_graduation", progress))];
}
