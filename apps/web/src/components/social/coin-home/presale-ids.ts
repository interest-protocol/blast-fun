import { HOME_COINS_MAX_IDS, type HomeCoinsByIds, type HomeWindow } from "@blast/core/web/contracts/home.ts";
import type { SocialHappeningResponse } from "@blast/core/web/contracts/happening.ts";
import { isPinnablePresale } from "@blast/core/web/contracts/presales.ts";

/** Bound the dataset to the existing batch-read limit; the table paginates it. */
export const PRESALE_ROWS = HOME_COINS_MAX_IDS;

/**
 * The sale ids the presales block shows, from the happening read: pins first
 * (editorial, said so), then open sales by fill speed, then those opening
 * soon; each once. Shared by the server page (which reads their items) and
 * the block itself, so both name the same sales.
 */
export function presaleIdsOf(read: SocialHappeningResponse | null, nowMs: number): Readonly<{ ids: readonly string[]; featured: ReadonlySet<string> }> {
  if (!read) return { ids: [], featured: new Set() };
  const eligibleIds = (rows: SocialHappeningResponse["today"]) => rows.filter((row) => isPinnablePresale(row.presale, nowMs)).map((row) => row.presale.presale_id);
  const featured = new Set(eligibleIds(read.today));
  const ordered = [...featured, ...eligibleIds(read.fastest), ...eligibleIds(read.opening_soon)];
  return { ids: [...new Set(ordered)].slice(0, PRESALE_ROWS), featured };
}

/** Reuse a server seed only when it covers every currently displayed sale and window. */
export function presaleSeed(initial: HomeCoinsByIds | null, ids: readonly string[], window: HomeWindow): HomeCoinsByIds | null {
  if (!initial || initial.window !== window) return null;
  return ids.every((id) => initial.coins.some((coin) => coin.presale_id === id)) ? initial : null;
}
