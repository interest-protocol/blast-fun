import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import type { SocialItemResponse } from "@blast/core/modules/social/contracts/item-routes.ts";
import { readAsOf, toItems } from "@blast/server/modules/social/items/index.ts";
import { visibleEntry } from "@blast/server/modules/social/read-model/index.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

/**
 * One public item by entry id (a post permalink): the read model's visible
 * entry, mapped exactly as a feed page maps it, with the read's `as_of`.
 * Null when the entry is not visible, does not exist or is a hidden kind.
 * Without a readable watermark the read is `service_unavailable`, as the feed.
 */
export async function readPost(
  db: ReadableDatabase,
  entryId: string,
  request: Readonly<{ config: SocialConfig; nowMs: number; hiddenKinds: readonly string[] }>,
): Promise<SocialItemResponse | null> {
  const { config, nowMs } = request;
  const [entry, asOf] = await Promise.all([
    visibleEntry(db, entryId, { bigCommitUsd: config.big_commit_usd, bigTradeUsd: config.big_trade_usd }),
    readAsOf(db),
  ]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  if (!entry || request.hiddenKinds.includes(entry.kind)) return null;
  const [item] = await toItems(db, [entry], { nowMs, config });
  return item ? { item, as_of: asOf } : null;
}
