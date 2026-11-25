import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_FOLLOW_LIMIT } from "@blast/core/modules/social/contracts/follows.ts";
import type { SocialBuyAlert, SocialFollowingWallets } from "@blast/core/modules/social/contracts/buy-alerts.ts";
import { coinLabel } from "@blast/core/modules/social/contracts/financial-wire.ts";
import { toUsd } from "@blast/core/modules/social/items/decimal.ts";
import { namedWalletsOfSql, namedWalletsSql } from "@blast/core/modules/social/read-model/naming.ts";

import { actorOf, type IdentityRow } from "@blast/server/modules/social/home/aggregate.ts";
import { HOME_COIN_SOURCES } from "@blast/server/modules/social/home/sources.ts";

/** $1 viewer, $2 cap: the wallets the naming rule names now for the accounts the viewer follows. */
const FOLLOWING_WALLETS_SQL = `SELECT n.address FROM (${namedWalletsSql(`named_account.account_id IN (SELECT f.target_id::uuid FROM social_follows f
    WHERE f.follower_account_id = $1::uuid AND f.target_kind = 'account')`)}) n
  ORDER BY n.address LIMIT $2::int`;

/** $1..$4 the row's key: one activity row by its primary key. */
const ROW_SQL = `SELECT a.kind, a.actor, a.presale_id, a.coin_type, a.timestamp_ms::text AS timestamp_ms,
    a.usd_value::text AS usd_value, a.market_cap_usd::text AS market_cap_usd
  FROM chain_read_v1.activity a
  WHERE a.checkpoint = $1::bigint AND a.tx_slot = $2::bigint AND a.event_slot = $3::bigint AND a.part = $4::bigint`;

/**
 * $1 the coin key, $2 the wallet, $3 the trade's time: the shown coin (Home's
 * sources: a shown sale, or a launch's curve coin) and the account the naming
 * rule names the wallet by at that time, if any.
 */
const coinSql = (key: "presale_id" | "sale_token") => `SELECT c.presale_id, c.sale_token, c.sale_symbol, c.sale_name, c.sale_icon_url,
    (SELECT n.account_id::text FROM (${namedWalletsOfSql("ARRAY[$2::text]")}) n WHERE n.named_from_ms <= $3::bigint LIMIT 1) AS account_id
  FROM ${HOME_COIN_SOURCES} c WHERE c.${key} = $1::text LIMIT 1`;
const SALE_COIN_SQL = coinSql("presale_id");
const TYPE_COIN_SQL = coinSql("sale_token");

const IDENTITY_SQL = `SELECT account_id, callsign, display_name, avatar_url, x_handle, verified
  FROM social_account_identities WHERE account_id = $1::uuid`;

for (const text of [FOLLOWING_WALLETS_SQL, ROW_SQL, SALE_COIN_SQL, TYPE_COIN_SQL, IDENTITY_SQL]) assertChainReadThroughViews(text);

/** The followed wallets a tab filters activity hints by, at most the follow limit. */
export async function readFollowingWallets(db: ReadableDatabase, viewerAccountId: string): Promise<SocialFollowingWallets> {
  const { rows } = await db.read<{ address: string }>(FOLLOWING_WALLETS_SQL, [viewerAccountId, SOCIAL_FOLLOW_LIMIT]);
  return { wallets: [...new Set(rows.map((row) => row.address))] };
}

type Row = Readonly<{
  kind: string;
  actor: string;
  presale_id: string | null;
  coin_type: string | null;
  timestamp_ms: string;
  usd_value: string | null;
  market_cap_usd: string | null;
}>;

type CoinRow = Readonly<{
  presale_id: string | null;
  sale_token: string;
  sale_symbol: string | null;
  sale_name: string | null;
  sale_icon_url: string | null;
  account_id: string | null;
}>;

/**
 * One trade's buy card, or null when the row is not a named buy of a shown
 * coin (unknown id, a sell or a commit, a hidden sale, a wallet the naming
 * rule does not name, an account without a callsign).
 */
export async function readBuyAlert(db: ReadableDatabase, activityId: string): Promise<SocialBuyAlert | null> {
  const key = activityId.split(":");
  const row = (await db.read<Row>(ROW_SQL, key)).rows[0];
  if (!row || row.kind !== "trade_buy") return null;
  const coinKey = row.presale_id ?? row.coin_type;
  if (coinKey === null) return null;
  const coin = (await db.read<CoinRow>(row.presale_id ? SALE_COIN_SQL : TYPE_COIN_SQL, [coinKey, row.actor, row.timestamp_ms])).rows[0];
  if (!coin || coin.account_id === null) return null;
  const identity = (await db.read<IdentityRow>(IDENTITY_SQL, [coin.account_id])).rows[0];
  if (!identity) return null;
  const actor = actorOf({ account_id: identity.account_id, wallet: row.actor }, new Map([[identity.account_id, identity]]));
  if (actor.type !== "account") return null;
  return {
    activity_id: activityId,
    occurred_at_ms: Number(row.timestamp_ms),
    actor,
    wallet: row.actor,
    coin: {
      presale_id: coin.presale_id,
      coin_type: coin.sale_token,
      ...coinLabel({ coinType: coin.sale_token, symbol: coin.sale_symbol, name: coin.sale_name }),
      icon_url: coin.sale_icon_url || null,
    },
    usd: row.usd_value === null ? null : toUsd(row.usd_value),
    market_cap_usd: row.market_cap_usd === null ? null : toUsd(row.market_cap_usd),
  };
}
