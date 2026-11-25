import assert from "node:assert/strict";
import test from "node:test";

import type { DiscoveryResponse, DiscoveryRow } from "@blast/core/modules/launchpad-discovery/rows.ts";

import { closestLiveCurve } from "./bonding-client.ts";

const row = (launchId: string, name: string, lifecycle: DiscoveryRow["lifecycle"] = "live") =>
  ({ launchId, name, symbol: "COIN", lifecycle, progressBps: 9_000 }) as DiscoveryRow;
const page = (rows: DiscoveryRow[]) =>
  ({ view: "new", section: { state: "available", data: { rows, nextCursor: null } } }) as unknown as DiscoveryResponse;

test("Home highlights the closest live curve that is not about the founder or a slur", () => {
  const rows = [row("ready", "Froggy", "migration_ready"), row("founder", "The Adeniyi"), row("frog", "Froggy")];
  assert.equal(closestLiveCurve(page(rows))?.launchId, "frog");
  assert.equal(closestLiveCurve(page([row("founder", "Eman")])), undefined);
});
