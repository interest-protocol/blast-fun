import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import type { DiscoveryRow } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";

/** The coin types among `coinTypes` that Blast verified (`social_coin_trust`). */
export type VerifiedReader = (coinTypes: readonly string[]) => Promise<ReadonlySet<string>>;

/** How long a process reuses the verified set; a new mark (admin website) shows within this. */
const TRUST_TTL_MS = 10_000;
let trusted: Readonly<{ atMs: number; read: Promise<ReadonlySet<string>> }> | null = null;

/**
 * The verified set is small, admin-written and the same for every viewer, so each process reads it whole at
 * most once per TTL, concurrent requests sharing the read in flight; a failed read is retried on the next request.
 */
function trustedCoins(nowMs = Date.now()): Promise<ReadonlySet<string>> {
  if (trusted && nowMs - trusted.atMs < TRUST_TTL_MS) return trusted.read;
  const read = autocommitReader(databaseFor("search"), "social", { label: "launchpad.discovery_verified" })
    .read<{ coin_type: string }>("SELECT coin_type FROM social_coin_trust")
    .then(({ rows }) => new Set(rows.map((row) => row.coin_type)));
  const entry = { atMs: nowMs, read };
  trusted = entry;
  read.catch(() => { if (trusted === entry) trusted = null; });
  return read;
}

const savedVerified: VerifiedReader = async (coinTypes) => {
  const all = await trustedCoins();
  return new Set(coinTypes.filter((coinType) => all.has(coinType)));
};

/**
 * R3-23: the response-level `verifiedTeam` (launch IDs) beside a page's rows, from the per-process verified set.
 * It sits outside the strict row contract, as `metrics` does, so open older clients ignore it. The mark is
 * extra: a failed read serves the page without it.
 */
export async function verifiedTeamOf(
  rows: readonly DiscoveryRow[],
  read: VerifiedReader = savedVerified,
): Promise<{ verifiedTeam?: string[] }> {
  if (rows.length === 0) return {};
  const verified = await read([...new Set(rows.map((row) => row.coinType))]).catch(() => new Set<string>());
  const launches = rows.filter((row) => verified.has(row.coinType)).map((row) => row.launchId);
  return launches.length ? { verifiedTeam: launches } : {};
}
