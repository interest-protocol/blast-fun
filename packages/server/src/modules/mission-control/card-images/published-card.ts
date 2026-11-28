import { z } from "zod";
import type { Pool } from "pg";

import type { SeasonZeroCardRecord } from "@blast/core/modules/mission-control/card-renderer/contract.ts";
import { autocommitRead } from "@blast/core/modules/database/transaction.ts";
import { primaryPool } from "@blast/core/modules/database/pool.ts";

import type { PublishedCardSnapshot } from "@blast/core/modules/mission-control/card-images/contracts.ts";

const PUBLICATION = `c.card_id = $1 AND c.published_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM social_accounts a WHERE a.profile_id = c.profile_id AND a.deleted_at IS NOT NULL)`;

/** Checks publication without loading the record or its recruits for a cached render. */
export async function isCardPublished(cardId: string, pool?: Pool): Promise<boolean> {
  const result = await autocommitRead(
    pool ?? primaryPool(), "card",
    `SELECT 1 FROM mission_control_cards c WHERE ${PUBLICATION}`, [cardId],
    { label: "card.publication", prepare: true },
  );
  return result.rows.length !== 0;
}

export async function publishedCardSnapshot(
  cardId: string,
  pool?: Pool,
): Promise<PublishedCardSnapshot | null> {
  if (
    !z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      .safeParse(cardId).success
  )
    return null;
  const result = await autocommitRead<{
    card_record: SeasonZeroCardRecord;
    recruit_handles: string[];
    recruit_total: number;
  }>(
    pool ?? primaryPool(),
    "card",
    `SELECT c.card_record,
      (SELECT COUNT(*)::int FROM (
         SELECT r.recruited_profile_id
         FROM mission_control_referrals r
         WHERE r.referrer_profile_id = c.profile_id
         UNION ALL
         SELECT a.recruited_profile_id
         FROM mission_control_seed_creator_attributions a
         JOIN mission_control_seed_creators sc
           ON sc.seed_creator_id = a.seed_creator_id
         WHERE sc.profile_id = c.profile_id
       ) attributed) AS recruit_total,
      ARRAY(
        SELECT recruited.x_handle
        FROM (
          SELECT r.recruited_profile_id, r.created_at
          FROM mission_control_referrals r
          WHERE r.referrer_profile_id = c.profile_id
          UNION ALL
          SELECT a.recruited_profile_id, a.created_at
          FROM mission_control_seed_creator_attributions a
          JOIN mission_control_seed_creators sc
            ON sc.seed_creator_id = a.seed_creator_id
          WHERE sc.profile_id = c.profile_id
        ) referral
        JOIN mission_control_profiles recruited
          ON recruited.profile_id = referral.recruited_profile_id
        WHERE recruited.x_handle IS NOT NULL
        ORDER BY referral.created_at DESC, recruited.profile_id DESC
        LIMIT 5
      ) AS recruit_handles
    FROM mission_control_cards c
    WHERE ${PUBLICATION}`,
    [cardId],
  );
  const row = result.rows[0];
  return row
    ? Object.freeze({
        record: row.card_record,
        recruitHandles: Object.freeze(row.recruit_handles),
        recruitTotal: row.recruit_total,
      })
    : null;
}
