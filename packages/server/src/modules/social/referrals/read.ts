import { RECRUITS_SQL } from "./recruits.ts";
import { readReferralAccounting } from "./revenue.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { toUsd } from "@blast/core/modules/social/items/decimal.ts";
import {
  REFERRAL_PAGE_SIZE,
  type ReferralInvitee,
  type ReferralInvitees,
  type ReferralSummary,
} from "@blast/core/modules/social/referrals/contracts.ts";

// Keep launch-code and seed-creator attribution, even for members whose social account was created later.
// Confirmed in-app swaps have one immutable log row per digest.
// The legacy USD statistic is informational; earnings use exact confirmed native fees.

const SUMMARY_SQL = `SELECT * FROM (${RECRUITS_SQL}, volume AS (
  SELECT t.usd_value
  FROM recruits r
  JOIN social_transactions t ON t.account_id = r.account_id
    AND t.created_at_ms >= floor(extract(epoch FROM r.joined_at) * 1000)
  WHERE t.kind IN ('trade_buy', 'trade_sell') AND t.state = 'confirmed'
)
SELECT (SELECT count(*)::int FROM recruits) AS invited,
  COALESCE(sum(usd_value), 0)::text AS volume_usd,
  count(*) FILTER (WHERE usd_value IS NULL)::int AS unvalued_trades
FROM volume) summary`;

/** Owner-only aggregate volume, collected revenue and lifetime earnings. */
export async function readReferralSummary(
  database: ReadableDatabase,
  accountId: string,
): Promise<ReferralSummary> {
  const { rows } = await database.read<ReferralSummary>(SUMMARY_SQL, [
    accountId,
  ]);
  const row = rows[0];
  if (!row) throw new Error("Referral summary returned no row.");
  const [accounting, code] = await Promise.all([
    readReferralAccounting(database, accountId),
    database.read<{ code: string }>(
      "SELECT code FROM social_referral_reservations WHERE owner_account_id=$1",
      [accountId],
    ),
  ]);
  return {
    ...row,
    volume_usd: toUsd(row.volume_usd),
    accounting: accounting.total,
    referral_code: code.rows[0]?.code,
  };
}

/**
 * A bounded owner-only list with each invitee’s aggregate economics. `joined_at_ms` is when the invitee was first attributed to the
 * owner (the earliest of its account, launch-code and seed-creator records),
 * the moment the summary counts its trades from.
 */
export async function readReferralInvitees(
  database: ReadableDatabase,
  accountId: string,
  cursor: string | null,
): Promise<ReferralInvitees> {
  const { rows } = await database.read<ReferralInvitee>(
    `SELECT * FROM (${RECRUITS_SQL}
    SELECT COALESCE(a.profile_id, r.recruit_id)::text AS id, i.callsign,
      COALESCE(i.display_name, p.display_name, p.callsign) AS display_name,
      CASE WHEN a.account_id IS NULL THEN COALESCE(p.avatar_reference, p.x_avatar_reference) ELSE i.avatar_url END AS avatar_url,
      COALESCE(i.x_handle, p.x_handle) AS x_handle,
      floor(extract(epoch FROM r.joined_at) * 1000)::float8 AS joined_at_ms
    FROM recruits r
    LEFT JOIN social_accounts a ON a.account_id = r.account_id
    LEFT JOIN social_account_identities i ON i.account_id = r.account_id
    LEFT JOIN mission_control_profiles p ON p.profile_id = COALESCE(a.profile_id, r.recruit_id)
    WHERE ($2::uuid IS NULL OR COALESCE(a.profile_id, r.recruit_id) > $2::uuid)
    ORDER BY COALESCE(a.profile_id, r.recruit_id) LIMIT $3) invitees`,
    [accountId, cursor, REFERRAL_PAGE_SIZE + 1],
  );
  const accounting = await readReferralAccounting(
    database,
    accountId,
    rows.slice(0, REFERRAL_PAGE_SIZE).map((row) => row.id),
  );
  const invitees = rows
    .slice(0, REFERRAL_PAGE_SIZE)
    .map((row) => ({ ...row, accounting: accounting.people.get(row.id) }));
  return {
    invitees,
    next_cursor: rows.length > REFERRAL_PAGE_SIZE ? invitees.at(-1)!.id : null,
  };
}
