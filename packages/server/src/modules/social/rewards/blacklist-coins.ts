import { z } from "zod";
import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

export function rewardCoinQuery(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim() ?? "";
  const after = params.get("after");
  const parsed = z.object({ query: z.string().max(2048), after: z.string().max(2048).regex(/^0x[0-9a-f]{64}::/)
    .refine((value) => isValidStructTag(value) && normalizeStructTag(value) === value).nullable() }).safeParse({ query, after });
  if (!parsed.success) throw new SocialRouteError("invalid_parameter");
  return { query, after };
}

/** Include migrated sales; pinning eligibility is unrelated to holder reward policy. */
export async function readRewardCoins(
  db: ReadableDatabase,
  input: { query: string; after: string | null },
) {
  const { rows } = await db.read<{
    coin_type: string;
    name: string;
    symbol: string;
  }>(
    `SELECT sale_token AS coin_type, coalesce(min(sale_name),'Unnamed coin') AS name, coalesce(min(sale_symbol),'?') AS symbol
     FROM chain_read_v1.presales
     GROUP BY sale_token
     HAVING count(*)=1 AND ($1::text IS NULL OR sale_token COLLATE "C">$1)
       AND ($2='' OR strpos(lower(coalesce(min(sale_name),'')||' '||coalesce(min(sale_symbol),'')||' '||sale_token),lower($2))>0)
     ORDER BY sale_token COLLATE "C" LIMIT 101`,
    [input.after, input.query],
  );
  return {
    coins: rows.slice(0, 100),
    next_cursor: rows.length > 100 ? rows[99]!.coin_type : null,
  };
}
