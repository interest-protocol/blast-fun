import { z } from "zod";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import {
  SPECIAL_REFERRAL_SHARE_BPS,
  STANDARD_REFERRAL_SHARE_BPS,
  type ReferralAccounting,
  type ReferralAsset,
} from "@blast/core/modules/social/referrals/contracts.ts";
import { RECRUITS_SQL } from "./recruits.ts";

const ratePolicySchema = z.object({
  effective_at_ms: z.number().int().positive(),
  special_account_ids: z.array(z.string().uuid()),
  special_reservation_codes: z.array(z.string().regex(/^[a-z0-9_]{3,20}$/)),
});

// Floor the combined share once per invitee/asset. A null standard rate start keeps all fees at 60%.
export const REFERRAL_REVENUE_SQL = `SELECT * FROM (${RECRUITS_SQL}, cut AS (
 SELECT (value->>'complete_checkpoint')::bigint AS checkpoint,(value->>'as_of_ms')::bigint AS as_of_ms
 FROM social_worker_state WHERE name='referral-accounting'
), evidence AS (
 SELECT e.*, ($3::bigint IS NULL OR e.timestamp_ms<$3
   OR COALESCE(e.timestamp_ms >= $4::bigint,false)) AS special_rate
 FROM social_referral_events e JOIN cut ON e.checkpoint<=cut.checkpoint
), owned AS (
 SELECT COALESCE(a.profile_id,r.recruit_id)::text AS person_id,e.*,
   COALESCE(a.referrer_reservation_code=$5::text,false) AS special_reservation
 FROM recruits r
 JOIN social_accounts a ON a.account_id=r.account_id
 JOIN social_wallet_owners w ON w.account_id=r.account_id
 JOIN evidence e ON e.sender=w.address AND e.timestamp_ms>=extract(epoch FROM GREATEST(r.joined_at,w.linked_at))*1000
 WHERE e.kind IN ('curve','commit') AND ($2::text[] IS NULL OR COALESCE(a.profile_id,r.recruit_id)::text=ANY($2))
), curve AS (
 SELECT e.*,l.quote_type AS quote_coin,t.meme_type AS meme_coin,
   e.special_reservation OR COALESCE(claim.special_rate,e.special_rate) AS special_revenue,
   CASE WHEN NOT l.partnered THEN e.quote_atoms
     WHEN settled.unambiguous AND settled.quote_gross=claim.total_atoms AND settled.meme_gross=claim.accepted_atoms
       THEN div(e.quote_atoms*claim.quote_atoms,NULLIF(claim.total_atoms,0)) END AS quote_revenue,
   CASE WHEN NOT l.partnered THEN e.meme_atoms
     WHEN settled.unambiguous AND settled.quote_gross=claim.total_atoms AND settled.meme_gross=claim.accepted_atoms
       THEN div(e.meme_atoms*claim.meme_atoms,NULLIF(claim.accepted_atoms,0)) END AS meme_revenue
 FROM owned e
 LEFT JOIN social_referral_entities l ON l.entity_id=e.entity_id AND l.kind='launch'
 LEFT JOIN social_referral_entities t ON t.entity_id=l.ticket_id AND t.kind='ticket'
 LEFT JOIN LATERAL (SELECT c.* FROM evidence c WHERE c.entity_id=e.entity_id AND c.kind='curve_claim'
   AND (c.checkpoint>e.checkpoint OR (c.checkpoint=e.checkpoint AND c.digest=e.digest AND c.event_index>e.event_index))
   ORDER BY c.checkpoint,c.digest,c.event_index LIMIT 1) claim ON l.partnered
 LEFT JOIN LATERAL (SELECT p.* FROM evidence p WHERE p.entity_id=e.entity_id AND p.kind='curve_claim'
   AND (p.checkpoint<claim.checkpoint OR (p.checkpoint=claim.checkpoint AND p.digest=claim.digest AND p.event_index<claim.event_index))
   ORDER BY p.checkpoint DESC,p.digest DESC,p.event_index DESC LIMIT 1) previous ON l.partnered
 LEFT JOIN LATERAL (SELECT COALESCE(sum(g.quote_atoms),0) AS quote_gross,COALESCE(sum(g.meme_atoms),0) AS meme_gross,
   (NOT EXISTS (SELECT 1 FROM evidence edge WHERE edge.entity_id=e.entity_id
     AND edge.kind IN ('curve','graduation','curve_claim') AND
       ((edge.checkpoint=claim.checkpoint AND edge.digest<>claim.digest)
         OR (edge.checkpoint=previous.checkpoint AND edge.digest<>previous.digest)
         OR (edge.kind='curve_claim' AND edge.checkpoint=e.checkpoint AND edge.digest<>e.digest)))
    AND (previous.checkpoint IS NULL OR e.checkpoint>previous.checkpoint
      OR (e.checkpoint=previous.checkpoint AND e.digest=previous.digest AND e.event_index>previous.event_index))) AS unambiguous
   FROM evidence g WHERE g.entity_id=e.entity_id AND g.kind IN ('curve','graduation')
     AND (g.checkpoint<claim.checkpoint OR (g.checkpoint=claim.checkpoint AND g.digest=claim.digest AND g.event_index<claim.event_index))
     AND (previous.checkpoint IS NULL OR g.checkpoint>previous.checkpoint
       OR (g.checkpoint=previous.checkpoint AND g.digest=previous.digest AND g.event_index>previous.event_index))) settled ON l.partnered
 WHERE e.kind='curve'
), paid_sales AS (
 SELECT f.entity_id,f.total_atoms,f.accepted_atoms,sum(p.quote_atoms) AS paid,
   sum(p.quote_atoms) FILTER (WHERE p.special_rate) AS special_paid
 FROM evidence f LEFT JOIN evidence p ON p.entity_id=f.entity_id AND p.kind='presale_fee' AND p.checkpoint>=f.checkpoint
 WHERE f.kind='funded' AND f.total_atoms>0 AND f.accepted_atoms<=f.total_atoms
   AND NOT EXISTS (SELECT 1 FROM evidence x WHERE x.entity_id=f.entity_id AND x.kind='cancelled')
 GROUP BY f.entity_id,f.total_atoms,f.accepted_atoms
), commitments AS (
 SELECT person_id,entity_id,quote_type,special_reservation,sum(volume_atoms) AS volume_atoms FROM owned WHERE kind='commit'
 GROUP BY person_id,entity_id,quote_type,special_reservation
), amounts AS (
 SELECT person_id,quote_coin AS coin_type,CASE WHEN quote_coin IS NULL THEN 0 ELSE volume_atoms END AS volume_atoms,COALESCE(quote_revenue,0) AS revenue_atoms,
   CASE WHEN special_revenue THEN COALESCE(quote_revenue,0) ELSE 0 END AS special_revenue_atoms,
   (quote_coin IS NULL OR meme_coin IS NULL OR (quote_revenue IS NULL AND quote_atoms>0))::int AS pending FROM curve
 UNION ALL
 SELECT person_id,meme_coin,0,COALESCE(meme_revenue,0),
   CASE WHEN special_revenue THEN COALESCE(meme_revenue,0) ELSE 0 END,
   (meme_revenue IS NULL AND meme_atoms>0)::int FROM curve WHERE meme_coin IS NOT NULL
 UNION ALL
 SELECT c.person_id,c.quote_type,div(c.volume_atoms*s.accepted_atoms,s.total_atoms),
   div(c.volume_atoms*COALESCE(s.paid,0),s.total_atoms),
   div(c.volume_atoms*COALESCE(CASE WHEN c.special_reservation THEN s.paid ELSE s.special_paid END,0),s.total_atoms),
   (s.paid IS NULL)::int
 FROM commitments c JOIN paid_sales s ON s.entity_id=c.entity_id
)
SELECT r.person_id,r.coin_type,m.symbol,m.decimals,sum(r.volume_atoms)::text AS volume_atoms,
 sum(r.revenue_atoms)::text AS revenue_atoms,
 div(sum(r.revenue_atoms)*${STANDARD_REFERRAL_SHARE_BPS}
   +sum(r.special_revenue_atoms)*${SPECIAL_REFERRAL_SHARE_BPS - STANDARD_REFERRAL_SHARE_BPS},10000)::text AS earnings_atoms,
 sum(r.pending)::int AS pending
FROM amounts r LEFT JOIN chain_read_v1.coin_metadata m ON m.coin_type=r.coin_type
GROUP BY r.person_id,r.coin_type,m.symbol,m.decimals ORDER BY r.person_id,r.coin_type) economics`;
assertChainReadThroughViews(REFERRAL_REVENUE_SQL);

type Row = Omit<ReferralAsset, "coin_type"> & {
  coin_type: string | null;
  person_id: string;
  pending: number;
};
export async function readReferralAccounting(
  db: ReadableDatabase,
  accountId: string,
  people?: readonly string[],
) {
  const { rows: [state] } = await db.read<{
    as_of_ms: number | null;
    now_ms: number;
    reservation_code: string | null;
    reservation_claimed_at_ms: number | null;
    rate_policy: unknown;
  }>(`SELECT
    (SELECT (value->>'as_of_ms')::float8 FROM social_worker_state WHERE name='referral-accounting') AS as_of_ms,
    floor(extract(epoch FROM now())*1000)::float8 AS now_ms,
    r.code AS reservation_code,
    floor(extract(epoch FROM r.claimed_at)*1000)::float8 AS reservation_claimed_at_ms,
    (SELECT value FROM social_config WHERE key='referral_rate_policy') AS rate_policy
    FROM social_accounts a
    LEFT JOIN social_referral_reservations r ON r.owner_account_id=a.account_id
    WHERE a.account_id=$1`, [accountId]);
  const asOf = state?.as_of_ms || null;
  const policy = !state || state.rate_policy === null ? null : ratePolicySchema.parse(state.rate_policy);
  const standardRateFrom = state && policy && policy.effective_at_ms <= state.now_ms
    && !policy.special_account_ids.includes(accountId)
    ? policy.effective_at_ms
    : null;
  const specialReservation = state?.reservation_code && policy?.special_reservation_codes.includes(state.reservation_code)
    ? state.reservation_code
    : null;
  const specialRateFrom = specialReservation ? state?.reservation_claimed_at_ms ?? null : null;
  const shareBps = standardRateFrom === null || specialRateFrom !== null
    ? SPECIAL_REFERRAL_SHARE_BPS
    : STANDARD_REFERRAL_SHARE_BPS;
  const empty = (): ReferralAccounting => ({
    assets: [],
    share_bps: shareBps,
    as_of_ms: asOf,
    pending_events: 0,
  });
  const total = empty();
  const byPerson = new Map<string, ReferralAccounting>(
    (people ?? []).map((id) => [id, empty()]),
  );
  if (asOf === null || people?.length === 0) return { total, people: byPerson };
  const { rows } = await db.read<Row>(REFERRAL_REVENUE_SQL, [
    accountId,
    people ?? null,
    standardRateFrom,
    specialRateFrom,
    specialReservation,
  ]);
  const assets = new Map<string, ReferralAsset>();
  for (const { person_id, pending, ...asset } of rows) {
    const person = byPerson.get(person_id) ?? empty();
    person.pending_events += pending;
    byPerson.set(person_id, person);
    total.pending_events += pending;
    if (asset.coin_type === null) continue;
    const knownAsset = { ...asset, coin_type: asset.coin_type };
    if (
      asset.volume_atoms !== "0" ||
      asset.revenue_atoms !== "0" ||
      pending > 0
    )
      person.assets.push(knownAsset);
    const accumulated = assets.get(asset.coin_type) ?? {
      ...knownAsset,
      volume_atoms: "0",
      revenue_atoms: "0",
      earnings_atoms: "0",
    };
    for (const key of [
      "volume_atoms",
      "revenue_atoms",
      "earnings_atoms",
    ] as const)
      accumulated[key] = String(BigInt(accumulated[key]) + BigInt(asset[key]));
    assets.set(asset.coin_type, accumulated);
  }
  total.assets = [...assets.values()].filter(
    (a) => a.volume_atoms !== "0" || a.revenue_atoms !== "0",
  );
  return { total, people: byPerson };
}
