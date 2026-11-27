import { z } from "zod";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import {
  SPECIAL_REFERRAL_SHARE_BPS,
  STANDARD_REFERRAL_SHARE_BPS,
  type ReferralAccounting,
  type ReferralAsset,
  type ReferralStatement,
} from "@blast/core/modules/social/referrals/contracts.ts";
import { RECRUITS_SQL } from "./recruits.ts";

const ratePolicySchema = z.object({
  effective_at_ms: z.number().int().positive(),
  special_account_ids: z.array(z.string().uuid()),
  special_reservation_codes: z.array(z.string().regex(/^[a-z0-9_]{3,20}$/)),
});

// A null standard rate start keeps all fees at 60%.
const REFERRAL_RECEIPTS_SQL = `${RECRUITS_SQL}, cut AS (
 SELECT (value->>'complete_checkpoint')::bigint AS checkpoint,(value->>'as_of_ms')::bigint AS as_of_ms
 FROM social_worker_state WHERE name='referral-accounting'
), evidence AS NOT MATERIALIZED (
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
 WHERE e.kind IN ('curve','commit')
   AND ($2::text[] IS NULL OR COALESCE(a.profile_id,r.recruit_id)::text=ANY($2))
), matched_curve AS MATERIALIZED (
 SELECT e.*,c.checkpoint AS claim_checkpoint,c.digest AS claim_digest,c.event_index AS claim_event_index,
   c.timestamp_ms AS collected_at_ms,c.special_rate AS claim_special_rate,c.total_atoms AS claim_atoms,
   c.quote_atoms AS collected_atoms
 FROM owned e
 LEFT JOIN LATERAL (SELECT c.* FROM evidence c WHERE c.entity_id=e.entity_id AND c.kind='curve_claim'
   AND e.quote_atoms>0 AND c.checkpoint>=e.checkpoint
   AND (c.checkpoint>e.checkpoint OR (c.checkpoint=e.checkpoint AND c.digest=e.digest AND c.event_index>e.event_index))
   ORDER BY c.checkpoint,c.digest,c.event_index LIMIT 1) c ON true
 WHERE e.kind='curve'
-- Keep one settlement calculation per claim even when many referred swaps share it.
), claim_windows AS MATERIALIZED (
 SELECT c.entity_id,c.claim_digest,c.claim_event_index,previous.checkpoint AS previous_checkpoint,
   previous.digest AS previous_digest,previous.event_index AS previous_event_index,
   settled.quote_gross,
   NOT EXISTS (SELECT 1 FROM evidence edge WHERE edge.entity_id=c.entity_id
     AND edge.kind IN ('curve','graduation','curve_claim')
     AND ((edge.checkpoint=c.claim_checkpoint AND edge.digest<>c.claim_digest)
       OR (edge.checkpoint=previous.checkpoint AND edge.digest<>previous.digest))) AS unambiguous
 FROM (SELECT DISTINCT entity_id,claim_checkpoint,claim_digest,claim_event_index FROM matched_curve
   WHERE claim_checkpoint IS NOT NULL) c
 LEFT JOIN LATERAL (SELECT p.checkpoint,p.digest,p.event_index FROM evidence p
   WHERE p.entity_id=c.entity_id AND p.kind='curve_claim' AND p.checkpoint<=c.claim_checkpoint
     AND (p.checkpoint<c.claim_checkpoint
       OR (p.checkpoint=c.claim_checkpoint AND p.digest=c.claim_digest AND p.event_index<c.claim_event_index))
   ORDER BY p.checkpoint DESC,p.digest DESC,p.event_index DESC LIMIT 1) previous ON true
 CROSS JOIN LATERAL (SELECT COALESCE(sum(g.quote_atoms),0) AS quote_gross
   FROM evidence g WHERE g.entity_id=c.entity_id AND g.kind IN ('curve','graduation')
     AND g.checkpoint BETWEEN COALESCE(previous.checkpoint,0) AND c.claim_checkpoint
     AND (g.checkpoint<c.claim_checkpoint
       OR (g.checkpoint=c.claim_checkpoint AND g.digest=c.claim_digest AND g.event_index<c.claim_event_index))
     AND (previous.checkpoint IS NULL OR g.checkpoint>previous.checkpoint
       OR (g.checkpoint=previous.checkpoint AND g.digest=previous.digest AND g.event_index>previous.event_index))) settled
), curve AS (
 SELECT e.*,l.quote_type AS quote_coin,
   e.special_reservation OR CASE WHEN l.partnered THEN e.claim_special_rate ELSE e.special_rate END AS special_revenue,
   CASE WHEN w.unambiguous AND w.quote_gross=e.claim_atoms
     AND NOT EXISTS (SELECT 1 FROM evidence edge WHERE edge.entity_id=e.entity_id
       AND edge.kind='curve_claim' AND edge.checkpoint=e.checkpoint AND edge.digest<>e.digest)
     AND (w.previous_checkpoint IS NULL OR e.checkpoint>w.previous_checkpoint
       OR (e.checkpoint=w.previous_checkpoint AND e.digest=w.previous_digest AND e.event_index>w.previous_event_index))
     THEN div(e.quote_atoms*e.collected_atoms,NULLIF(e.claim_atoms,0)) END AS quote_revenue
 FROM matched_curve e
 LEFT JOIN social_referral_entities l ON l.entity_id=e.entity_id AND l.kind='launch'
 LEFT JOIN claim_windows w ON w.entity_id=e.entity_id AND w.claim_digest=e.claim_digest AND w.claim_event_index=e.claim_event_index
)`;

// Floor the combined share once per invitee and asset in the lifetime report.
export const REFERRAL_REVENUE_SQL = `SELECT * FROM (${REFERRAL_RECEIPTS_SQL}, paid_sales AS (
 SELECT f.entity_id,f.total_atoms,f.accepted_atoms,sum(p.quote_atoms) AS paid,
   sum(p.quote_atoms) FILTER (WHERE p.special_rate) AS special_paid
 FROM evidence f LEFT JOIN evidence p ON p.entity_id=f.entity_id AND p.kind='presale_fee'
   AND p.quote_type=f.quote_type AND p.checkpoint>=f.checkpoint
 WHERE f.kind='funded' AND f.total_atoms>0 AND f.accepted_atoms<=f.total_atoms
   AND NOT EXISTS (SELECT 1 FROM evidence x WHERE x.entity_id=f.entity_id AND x.kind='cancelled')
 GROUP BY f.entity_id,f.total_atoms,f.accepted_atoms
), commitments AS (
 SELECT person_id,entity_id,quote_type,special_reservation,sum(volume_atoms) AS volume_atoms FROM owned WHERE kind='commit'
 GROUP BY person_id,entity_id,quote_type,special_reservation
), amounts AS (
 SELECT person_id,quote_coin AS coin_type,CASE WHEN quote_coin IS NULL THEN 0 ELSE volume_atoms END AS volume_atoms,COALESCE(quote_revenue,0) AS revenue_atoms,
   CASE WHEN special_revenue THEN COALESCE(quote_revenue,0) ELSE 0 END AS special_revenue_atoms,
   (quote_coin IS NULL OR (quote_revenue IS NULL AND quote_atoms>0))::int AS pending FROM curve
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

const MONTHLY_REFERRAL_SQL = `SELECT * FROM (${REFERRAL_RECEIPTS_SQL}, commitments AS (
 SELECT entity_id,person_id,special_reservation,sum(volume_atoms) AS atoms
 FROM owned WHERE kind='commit' AND quote_type=$6
 GROUP BY entity_id,person_id,special_reservation
), presale_receipts AS (
 SELECT f.entity_id,f.total_atoms,
   date_trunc('month',to_timestamp(p.timestamp_ms/1000.0) AT TIME ZONE 'UTC')::date AS month,
   sum(p.quote_atoms) AS paid,
   COALESCE(sum(p.quote_atoms) FILTER (WHERE p.special_rate),0) AS special_paid
 FROM evidence f JOIN evidence p ON p.entity_id=f.entity_id AND p.kind='presale_fee'
   AND p.quote_type=$6 AND p.checkpoint>=f.checkpoint
 WHERE f.kind='funded' AND f.quote_type=$6 AND f.total_atoms>0 AND f.accepted_atoms<=f.total_atoms
   AND EXISTS (SELECT 1 FROM commitments c WHERE c.entity_id=f.entity_id)
   AND NOT EXISTS (SELECT 1 FROM evidence x WHERE x.entity_id=f.entity_id AND x.kind='cancelled')
 GROUP BY f.entity_id,f.total_atoms,month
), presale_months AS (
 SELECT *,sum(paid) OVER sale AS paid_through,
   sum(special_paid) OVER sale AS special_through
 FROM presale_receipts WINDOW sale AS (PARTITION BY entity_id ORDER BY month)
), contributions AS (
 SELECT date_trunc('month',to_timestamp(collected_at_ms/1000.0) AT TIME ZONE 'UTC')::date AS month,
   person_id,quote_revenue AS atoms,CASE WHEN special_revenue THEN quote_revenue ELSE 0 END AS special_atoms
 FROM curve WHERE quote_coin=$6 AND quote_revenue>0
 UNION ALL
 -- Allocate each month as the change in the running allocation, so a sale's
 -- months sum to the lifetime allocation instead of flooring every month.
 SELECT month,person_id,atoms,CASE WHEN special_reservation THEN atoms ELSE special_atoms END
 FROM (SELECT p.month,c.person_id,c.special_reservation,
   div(c.atoms*p.paid_through,p.total_atoms)-div(c.atoms*(p.paid_through-p.paid),p.total_atoms) AS atoms,
   div(c.atoms*p.special_through,p.total_atoms)-div(c.atoms*(p.special_through-p.special_paid),p.total_atoms) AS special_atoms
   FROM commitments c JOIN presale_months p ON p.entity_id=c.entity_id) presale
), invitee_totals AS (
 SELECT month,person_id,sum(atoms) AS atoms,sum(special_atoms) AS special_atoms,
   sum(atoms)*${STANDARD_REFERRAL_SHARE_BPS}
     +sum(special_atoms)*${SPECIAL_REFERRAL_SHARE_BPS - STANDARD_REFERRAL_SHARE_BPS} AS weighted_atoms
 -- Revenue and special revenue floor apart, so a month can add special atoms alone.
 FROM contributions WHERE atoms>0 OR special_atoms>0 GROUP BY month,person_id
-- Carry fractional mist forward so the monthly shares sum to the lifetime share.
), invitee_earnings AS (
 SELECT *,sum(weighted_atoms) OVER (PARTITION BY person_id ORDER BY month) AS cumulative
 FROM invitee_totals
), totals AS (
 SELECT month,sum(atoms) AS atoms,
   sum(div(cumulative,10000)-div(cumulative-weighted_atoms,10000)) AS earnings,
   LEAST(${SPECIAL_REFERRAL_SHARE_BPS},${STANDARD_REFERRAL_SHARE_BPS}
     +round(sum(special_atoms)*${SPECIAL_REFERRAL_SHARE_BPS - STANDARD_REFERRAL_SHARE_BPS}/NULLIF(sum(atoms),0)))::int AS share_bps
 FROM invitee_earnings GROUP BY month
), payments AS (
 SELECT month,amount_atoms,digest FROM social_referral_payments WHERE account_id=$1
), calendar AS (
 SELECT generate_series(LEAST((SELECT min(month) FROM totals),(SELECT min(month) FROM payments),current_month),
   current_month,interval '1 month')::date AS month
 FROM (SELECT date_trunc('month',now() AT TIME ZONE 'UTC') AS current_month) bounds
)
SELECT to_char(c.month,'YYYY-MM') AS month,
 CASE WHEN c.month <= (to_timestamp($7::float8/1000) AT TIME ZONE 'UTC')::date
   THEN COALESCE(t.atoms,0)::text END AS revenue_atoms,
 CASE WHEN c.month <= (to_timestamp($7::float8/1000) AT TIME ZONE 'UTC')::date
   THEN COALESCE(t.earnings,0)::text END AS earnings_atoms,
 CASE WHEN c.month <= (to_timestamp($7::float8/1000) AT TIME ZONE 'UTC')::date
   THEN COALESCE(t.share_bps,CASE WHEN $3::bigint IS NULL
   OR LEAST(c.month+interval '1 month'-interval '1 millisecond',now() AT TIME ZONE 'UTC') < to_timestamp($3/1000.0) AT TIME ZONE 'UTC'
   OR LEAST(c.month+interval '1 month'-interval '1 millisecond',now() AT TIME ZONE 'UTC') >= to_timestamp($4::bigint/1000.0) AT TIME ZONE 'UTC'
   THEN ${SPECIAL_REFERRAL_SHARE_BPS} ELSE ${STANDARD_REFERRAL_SHARE_BPS} END) END AS share_bps,
 CASE WHEN p.digest IS NOT NULL THEN jsonb_build_object('amount_atoms',p.amount_atoms::text,'digest',p.digest) END AS payment
FROM calendar c LEFT JOIN totals t USING (month) LEFT JOIN payments p USING (month)
ORDER BY c.month DESC) statement`;
assertChainReadThroughViews(MONTHLY_REFERRAL_SQL);

type Row = Omit<ReferralAsset, "coin_type"> & {
  coin_type: string | null;
  person_id: string;
  pending: number;
};
async function readReferralRates(db: ReadableDatabase, accountId: string) {
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
  const shareBps: ReferralAccounting["share_bps"] = standardRateFrom === null || specialRateFrom !== null
    ? SPECIAL_REFERRAL_SHARE_BPS
    : STANDARD_REFERRAL_SHARE_BPS;
  return { asOf, standardRateFrom, specialRateFrom, specialReservation, shareBps };
}

export async function readReferralMonths(db: ReadableDatabase, accountId: string) {
  const { asOf, standardRateFrom, specialRateFrom, specialReservation } = await readReferralRates(db, accountId);
  const { rows } = await db.read<ReferralStatement>(MONTHLY_REFERRAL_SQL, [
    accountId, null, standardRateFrom, specialRateFrom, specialReservation, SUI_COIN_TYPE, asOf,
  ]);
  return { months: rows };
}

export async function readReferralAccounting(
  db: ReadableDatabase,
  accountId: string,
  people?: readonly string[],
) {
  const { asOf, standardRateFrom, specialRateFrom, specialReservation, shareBps } = await readReferralRates(db, accountId);
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
    accountId, people ?? null, standardRateFrom, specialRateFrom, specialReservation,
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
