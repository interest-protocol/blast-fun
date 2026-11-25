import { HOME_COINS_MAX_IDS } from "@blast/core/web/contracts/home.ts";
import type { SocialHappeningResponse } from "@blast/core/web/contracts/happening.ts";
import { isPinnablePresale } from "@blast/core/web/contracts/presales.ts";

/** Bound the dataset to the existing batch-read limit; the table paginates it. */
export const PRESALE_ROWS = HOME_COINS_MAX_IDS;

/**
 * The sale ids a presales list shows, from the happening read: pins first
 * (editorial, said so), then open sales by fill speed, then those opening
 * soon; each once.
 */
export function presaleIdsOf(read: SocialHappeningResponse | null, nowMs: number): Readonly<{ ids: readonly string[]; featured: ReadonlySet<string> }> {
  if (!read) return { ids: [], featured: new Set() };
  const eligibleIds = (rows: SocialHappeningResponse["today"]) => rows.filter((row) => isPinnablePresale(row.presale, nowMs)).map((row) => row.presale.presale_id);
  const featured = new Set(eligibleIds(read.today));
  const ordered = [...featured, ...eligibleIds(read.fastest), ...eligibleIds(read.opening_soon)];
  return { ids: [...new Set(ordered)].slice(0, PRESALE_ROWS), featured };
}
