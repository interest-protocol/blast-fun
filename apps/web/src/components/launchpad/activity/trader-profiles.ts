"use client";

import { pollInterval } from "#web/lib/query/polling.ts";
import { useQuery } from "@tanstack/react-query";
import type { ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { traderProfileKey, traderProfilesPath, traderProfilesSchema, type TraderProfileRequest, type TraderProfiles } from "@blast/core/modules/social/contracts/trader-profiles.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { recentTrades } from "./recent-trades";
import { listDisplay, type ListState } from "./activity-model";

const NO_PROFILES: TraderProfiles = {};
/** The query key prefix of the trade list's profile lookup; the chart's people read its answers. */
export const TRADER_PROFILES_QUERY = "trader-profiles";

export async function loadTraderProfiles(traders: readonly TraderProfileRequest[], signal: AbortSignal, request: typeof fetch = gatedFetch): Promise<TraderProfiles> {
  const response = await request(traderProfilesPath(traders), { credentials: "omit", cache: "no-store", signal });
  if (!response.ok) throw new Error("Trader profiles unavailable");
  const profiles = traderProfilesSchema.parse(await response.json());
  const expected = new Set(traders.map(traderProfileKey));
  if (Object.keys(profiles).length !== expected.size || Object.keys(profiles).some((key) => !expected.has(key))) throw new Error("Invalid trader profiles");
  return profiles;
}

/** Revalidate public profiles on the existing poll. Keep the last good answer while the next one is pending. */
export function useTraderProfiles(launchId: string, activity: ListState<ActivityRow>, enabled: boolean, shownRows?: readonly ActivityRow[], leaving?: ActivityRow | null): TraderProfiles {
  const client = useAppQueryClient();
  const display = listDisplay(activity);
  const view = display.kind === "rows" && !display.stale ? display.view : null;
  const rows = shownRows ?? recentTrades(view?.rows ?? []);
  const traders = view ? rows.flatMap((row) => row.actor && view.rows.some((confirmed) => confirmed.position === row.position)
    ? [{ address: row.actor, timestampMs: row.timestampMs }] : []) : [];
  const active = enabled && view !== null;
  const query = useQuery({
    queryKey: [TRADER_PROFILES_QUERY, launchId, active],
    queryFn: ({ signal }) => loadTraderProfiles(traders, AbortSignal.any([signal, AbortSignal.timeout(15000)])),
    enabled: active && traders.length > 0,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (query) => pollInterval(15_000, query),
  }, client);
  if (!active || query.isError || !query.data) return NO_PROFILES;
  const eligible = new Set(traders.map(traderProfileKey));
  if (leaving?.actor && view.rows.some((row) => row.position === leaving.position)) {
    eligible.add(traderProfileKey({ address: leaving.actor, timestampMs: leaving.timestampMs }));
  }
  if (!eligible.size) return NO_PROFILES;
  const profiles = Object.entries(query.data);
  return profiles.every(([key]) => eligible.has(key)) ? query.data : Object.fromEntries(profiles.filter(([key]) => eligible.has(key)));
}
