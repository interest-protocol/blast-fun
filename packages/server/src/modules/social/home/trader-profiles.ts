import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { namedWalletsOfSql } from "@blast/core/modules/social/read-model/naming.ts";
import { traderProfileKey, type TraderProfileRequest, type TraderProfiles } from "@blast/core/modules/social/contracts/trader-profiles.ts";

/** Public identities only, named at each trade's time; one bounded indexed lookup. */
export async function readTraderProfiles(db: ReadableDatabase, traders: readonly TraderProfileRequest[]): Promise<TraderProfiles> {
  const { rows } = await db.read<{ address: string; timestamp_ms: string; callsign: string | null; avatar_url: string | null }>(`
    SELECT * FROM (WITH requested AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(address text, timestamp_ms bigint)
    ), named AS MATERIALIZED (
      ${namedWalletsOfSql("ARRAY(SELECT r.address FROM requested r)")}
    )
    SELECT r.address, r.timestamp_ms::text, p.callsign, p.avatar_url
    FROM requested r
    LEFT JOIN LATERAL (
      SELECT i.callsign, i.avatar_url
      FROM named n JOIN social_account_identities i ON i.account_id = n.account_id
      WHERE n.address = r.address AND n.named_from_ms <= r.timestamp_ms
      ORDER BY n.named_from_ms DESC, i.account_id
      LIMIT 1
    ) p ON true) AS profiles`, [JSON.stringify(traders.map(({ address, timestampMs }) => ({ address, timestamp_ms: timestampMs })))]);
  return Object.fromEntries(rows.map((row) => [
    traderProfileKey({ address: row.address, timestampMs: Number(row.timestamp_ms) }),
    row.callsign ? { callsign: row.callsign, avatarUrl: row.avatar_url } : null,
  ]));
}
