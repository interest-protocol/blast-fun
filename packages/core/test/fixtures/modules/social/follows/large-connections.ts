import type { Pool } from "pg";

export const SIZE = 100_000;
export const HUB = "00000000-0000-4000-9000-000000000000";
export const accountId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export async function seedLargeLists(admin: Pool): Promise<void> {
  await admin.query("INSERT INTO social_accounts (account_id, privy_did, callsign) VALUES ($1, 'did:privy:scale-hub', 'hub')", [HUB]);
  // Bounded batches also bound the callsign trigger's transaction advisory locks.
  for (let start = 1; start <= SIZE; start += 1_000) {
    await admin.query(`INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, privacy)
      SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
        'did:privy:scale-' || n, 'person' || n, 'Person ' || n,
        CASE WHEN n % 10 = 0 THEN 'private' ELSE 'public' END
      FROM generate_series($1::int, $2::int) n`, [start, Math.min(start + 999, SIZE)]);
  }
  await admin.query(`INSERT INTO social_follows (follower_account_id, target_kind, target_id, source, created_at)
    SELECT a.account_id, 'account', $1, 'user',
      '2026-10-14T12:00:00.123456Z'::timestamptz + (n / 100) * interval '1 second'
    FROM generate_series(1, $2::int) n JOIN social_accounts a
      ON a.account_id = ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid`, [HUB, SIZE]);
  await admin.query(`INSERT INTO social_follows (follower_account_id, target_kind, target_id, source, created_at)
    SELECT $1::uuid, 'account', follower_account_id::text, 'user', created_at
    FROM social_follows WHERE target_id = $1::text`, [HUB]);
  // Mixed target kinds must never enter the UUID expression index or the counts.
  await admin.query("INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1, 'presale', $2, 'user')", [HUB, `0x${"a".repeat(64)}`]);
  await admin.query("VACUUM ANALYZE");
}
