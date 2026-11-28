import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { cardEditionForCrew } from "@blast/core/modules/mission-control/card-renderer/editions.ts";
import { isCardIdentity, type CardIdentity } from "@blast/core/modules/social/contracts/card-identity.ts";

/** Read only the immutable public identity, never the avatar snapshot or private blob URL. */
export async function readCardIdentities(db: ReadableDatabase, callsigns: readonly string[]): Promise<Record<string, CardIdentity | null>> {
  // LIMIT keeps PostgreSQL on per-profile index lookups instead of scanning every card for a batch.
  const { rows } = await db.read<Omit<CardIdentity, "edition"> & { callsign: string }>(`
    SELECT p.callsign, m.crew_number::integer AS crew,
      CASE WHEN c.published_at IS NOT NULL THEN c.card_id::text ELSE NULL END AS published_card_id
    FROM mission_control_profiles p
    JOIN LATERAL (
      SELECT card_id, membership_id, published_at FROM mission_control_cards
      WHERE profile_id = p.profile_id LIMIT 1
    ) c ON true
    JOIN mission_control_season_memberships m ON m.membership_id = c.membership_id
    WHERE p.callsign = ANY($1::text[])
      AND NOT EXISTS (SELECT 1 FROM social_accounts a WHERE a.profile_id = p.profile_id AND a.deleted_at IS NOT NULL)`, [callsigns]);
  const answer: Record<string, CardIdentity | null> = Object.fromEntries(callsigns.map((callsign) => [callsign, null]));
  for (const row of rows) {
    // The renderer uses this immutable allocation too; avoid decompressing avatar JSON for each ring.
    const identity = { crew: row.crew, edition: cardEditionForCrew(row.crew), published_card_id: row.published_card_id };
    if (!isCardIdentity(identity)) throw new Error("Invalid stored card identity.");
    answer[row.callsign] = identity;
  }
  return answer;
}
