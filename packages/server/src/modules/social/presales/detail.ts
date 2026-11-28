import { DISPLAY_PRICES } from "@blast/core/modules/social/prices/test-sui.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { PresaleTerms } from "@blast/core/modules/presale/terms/index.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import type { AsOf, FeedItem } from "@blast/core/modules/social/contracts/items.ts";
import {
  PRESALE_BIG_COMMIT_USD,
  PRESALE_MOMENTUM_BIG_USD,
  PRESALE_MOMENTUM_WINDOWS,
  PRESALE_RAISE_POINTS,
  PRESALE_TOP_BACKERS,
  type PresaleMomentumWindow,
  type SocialPresaleBacker,
  type SocialPresaleDetail,
  type SocialPresaleMomentum,
  type SocialPresaleRaise,
  type SocialPresaleTerms,
  type SocialPresaleThesis,
  type SocialPresaleVesting,
} from "@blast/core/modules/social/contracts/presales.ts";
import { toItems } from "@blast/server/modules/social/items/index.ts";
import { entryFromRow, namedOwnerSql, personEntrySql, presalePostSql } from "@blast/server/modules/social/read-model/index.ts";
import {
  PERSON_COLUMNS,
  Params,
  activityOfEntrySql,
  identityJoinSql,
  latestThesisSql,
  namedPositionSql,
  personOf,
  type PersonColumns,
} from "@blast/core/modules/social/presales/sql.ts";
import { ratioBps, readSummaries, summaryOf, type SummaryRow } from "@blast/server/modules/social/presales/summary.ts";
import { vestingMsSql } from "@blast/core/modules/social/contracts/vesting.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { quotePerToken } from "@blast/server/modules/social/presales/quote-price.ts";
import { readSteps } from "@blast/server/modules/social/read-steps.ts";

/** How a commit row's quote atoms become USD in SQL: face value for USDC, else the row's event-time `usd_value`. */
function commitUsdSql(alias: string, stable: string, decimals: string): string {
  return `(CASE WHEN ${stable}::boolean THEN ${alias}.quote_amount / (10::numeric ^ ${decimals}::int) ELSE ${alias}.usd_value END)`;
}

/** Quote atoms in USD in TS, for a presale's own amounts: face value for USDC, else at `quoteUsd` (null without it). */
function atomsUsd(atoms: string | null, row: SummaryRow, quoteUsd: number | null): string | null {
  if (atoms === null) return null;
  const units = Number(atoms) / 10 ** row.quote_decimals;
  const price = row.stable ? 1 : quoteUsd;
  return price === null ? null : (units * price).toFixed(2);
}

type MomentumRow = Record<string, string | number | null>;

/** The four momentum windows ending at the watermark, in one scan of the last day's commits. */
async function readMomentum(
  db: ReadableDatabase,
  presaleId: string,
  row: SummaryRow,
  asOfMs: number,
): Promise<Record<PresaleMomentumWindow, SocialPresaleMomentum>> {
  const params = new Params();
  const presale = params.add(presaleId);
  const stable = params.add(row.stable);
  const decimals = params.add(row.quote_decimals);
  const end = params.add(asOfMs);
  const big = params.add(PRESALE_MOMENTUM_BIG_USD);
  const windows = Object.entries(PRESALE_MOMENTUM_WINDOWS) as [PresaleMomentumWindow, number][];
  const columns = windows.map(([name, ms]) => {
    const inWindow = `FILTER (WHERE c.timestamp_ms > ${end}::bigint - ${ms})`;
    return `count(*) ${inWindow} AS "${name}_commits",
      round(COALESCE(sum(c.usd) ${inWindow}, 0), 2)::text AS "${name}_total",
      COALESCE(sum(c.atoms) ${inWindow}, 0)::text AS "${name}_total_atoms",
      count(DISTINCT c.actor) ${inWindow} AS "${name}_backers",
      round(avg(c.usd) ${inWindow}, 2)::text AS "${name}_average",
      round(avg(c.atoms) ${inWindow})::text AS "${name}_average_atoms",
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY c.usd) ${inWindow})::numeric, 2)::text AS "${name}_median",
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY c.atoms) ${inWindow})::numeric)::text AS "${name}_median_atoms",
      COALESCE(sum(c.usd) FILTER (WHERE c.timestamp_ms > ${end}::bigint - ${ms} AND c.usd >= ${big}::numeric), 0)::text AS "${name}_big"`;
  });
  const { rows } = await db.read<MomentumRow>(
    `SELECT ${columns.join(",\n")}
     FROM (
       SELECT a.timestamp_ms, a.actor, ${commitUsdSql("a", stable, decimals)} AS usd, a.quote_amount AS atoms
       FROM chain_read_v1.activity a
       WHERE a.presale_id = ${presale} AND a.kind = 'presale_commit'
         AND a.timestamp_ms > ${end}::bigint - ${PRESALE_MOMENTUM_WINDOWS["1d"]} AND a.timestamp_ms <= ${end}::bigint
     ) c`,
    params.values,
  );
  const r = rows[0] ?? {};
  const out = {} as Record<PresaleMomentumWindow, SocialPresaleMomentum>;
  for (const [name] of windows) {
    const total = String(r[`${name}_total`] ?? "0");
    const bigUsd = Number(r[`${name}_big`] ?? 0);
    out[name] = {
      commits: Number(r[`${name}_commits`] ?? 0),
      total_usd: total,
      total_atoms: String(r[`${name}_total_atoms`] ?? "0"),
      backers: Number(r[`${name}_backers`] ?? 0),
      average_usd: (r[`${name}_average`] as string | null) ?? null,
      median_usd: (r[`${name}_median`] as string | null) ?? null,
      average_atoms: (r[`${name}_average_atoms`] as string | null) ?? null,
      median_atoms: (r[`${name}_median_atoms`] as string | null) ?? null,
      big_bps: Number(total) > 0 ? Math.round((bigUsd / Number(total)) * 10_000) : 0,
    };
  }
  return out;
}

type BackerRow = PersonColumns & Readonly<{ wallet: string; commitment: string; last_commit_ms: string | null; why: string | null }>;

/**
 * The sale's largest wallets ($1 the sale, $2 how many), named where the
 * naming rule allows (from the wallet's first commit), with the latest active
 * thesis on their commits. Every step reads only the kept wallets: the first
 * commits of all of them in one probe of the activity log (the sale's and the
 * wallets' indexes together), each wallet's owner once (`t` is materialized,
 * so the naming subquery is not repeated for every reference to it), and
 * each named account's identity by its key (`OFFSET 0`: flattened, the
 * planner hashed the whole identities view to name 25 wallets). The
 * statement starts with SELECT, as a `ReadableDatabase` requires.
 */
export const TOP_BACKERS_SQL = `SELECT b.wallet, b.commitment, b.last_commit_ms, b.person_callsign, b.person_display_name,
     b.person_avatar_url, b.person_verified, b.why
   FROM (
     WITH top AS MATERIALIZED (
       SELECT pp.wallet, pp.commitment, pp.last_commit_ms
       FROM chain_read_v1.presale_positions pp
       WHERE pp.presale_id = $1
       ORDER BY pp.commitment DESC, pp.wallet
       LIMIT $2
     ), first_commit AS MATERIALIZED (
       SELECT a.actor, min(a.timestamp_ms) AS ms
       FROM chain_read_v1.activity a
       WHERE a.presale_id = $1 AND a.kind = 'presale_commit' AND a.actor = ANY(ARRAY(SELECT top.wallet FROM top))
       GROUP BY a.actor
     ), t AS MATERIALIZED (
       SELECT top.wallet, top.commitment, top.last_commit_ms, ${namedPositionSql("top.wallet", "first_commit.ms")} AS account_id
       FROM top LEFT JOIN first_commit ON first_commit.actor = top.wallet
     )
     SELECT t.wallet, t.commitment::text AS commitment, t.last_commit_ms::text AS last_commit_ms, ${PERSON_COLUMNS},
       CASE WHEN t.account_id IS NULL THEN NULL ELSE ${latestThesisSql("$1", "t.account_id")} END AS why,
       t.commitment AS rank_commitment
     FROM t
     LEFT JOIN LATERAL (
       SELECT ii.callsign, ii.display_name, ii.avatar_url, ii.x_handle FROM social_account_identities ii WHERE ii.account_id = t.account_id
       OFFSET 0
     ) i ON TRUE
   ) b
   ORDER BY b.rank_commitment DESC, b.wallet`;

async function readTopBackers(db: ReadableDatabase, presaleId: string): Promise<BackerRow[]> {
  const { rows } = await db.read<BackerRow>(TOP_BACKERS_SQL, [presaleId, PRESALE_TOP_BACKERS]);
  return rows;
}

type ThesisRow = PersonColumns & Readonly<{
  why_id: string;
  entry_id: string;
  text: string;
  actor: string;
  quote_amount: string;
  usd: string | null;
  total: string | null;
  occurred_at_ms: string;
  rockets: number;
}>;

/**
 * Active theses on the sale's named commits (by `social_whys.presale_id`,
 * 0066): the why's author is the account the naming rule attributes the
 * commit to now. Largest commit first, then most rockets; at most 50.
 */
async function readTheses(db: ReadableDatabase, presaleId: string, row: SummaryRow): Promise<ThesisRow[]> {
  const { rows } = await db.read<ThesisRow>(
    `SELECT w.why_id::text AS why_id, w.entry_id, w.text, e.actor, e.quote_amount::text AS quote_amount, e.usd::text AS usd,
       e.total_commitments_after::text AS total, e.occurred_at_ms::text AS occurred_at_ms, ${PERSON_COLUMNS},
       (SELECT count(*)::int FROM social_reactions r WHERE r.entry_id = w.entry_id AND r.reaction = 'rocket') AS rockets
     FROM social_whys w
     CROSS JOIN LATERAL (
       SELECT a.actor, a.timestamp_ms AS occurred_at_ms, a.quote_amount, a.total_commitments_after,
         ${commitUsdSql("a", "$2", "$3")} AS usd
       FROM chain_read_v1.activity a
       WHERE ${activityOfEntrySql("w.entry_id")} AND a.kind = 'presale_commit' AND a.presale_id = $1
     ) e
     CROSS JOIN LATERAL (SELECT ${namedOwnerSql("e")} AS account_id) named
     ${identityJoinSql("named.account_id")}
     WHERE w.presale_id = $1 AND w.state = 'active' AND named.account_id = w.author_account_id
     ORDER BY e.quote_amount DESC, rockets DESC, w.why_id
     LIMIT 50`,
    [presaleId, row.stable, row.quote_decimals],
  );
  return rows;
}

type PointRow = Readonly<{ t: string; total: string | null }>;
type MarkerRow = PersonColumns & Readonly<{
  t: string;
  actor: string;
  quote_amount: string;
  usd: string | null;
  total: string | null;
  why: string | null;
}>;

/**
 * The cumulative raise, downsampled to at most `PRESALE_RAISE_POINTS` points
 * (each bucket keeps its last running total), and the commits worth marking:
 * every commit of `PRESALE_BIG_COMMIT_USD` or more and every commit with an
 * active thesis (at most 60, largest first), named by the feed's rule at the
 * commit's time.
 */
async function readRaise(
  db: ReadableDatabase,
  presaleId: string,
  row: SummaryRow,
  fromMs: number,
  toMs: number,
  quoteUsd: number | null,
  bigWallets: readonly string[],
  theses: readonly ThesisRow[],
): Promise<SocialPresaleRaise> {
  const span = Math.max(1, toMs - fromMs);
  const [points, big] = await Promise.all([
    db.read<PointRow>(
      `SELECT max(a.timestamp_ms)::text AS t, max(a.total_commitments_after)::text AS total
       FROM chain_read_v1.activity a
       WHERE a.presale_id = $1 AND a.kind = 'presale_commit' AND a.timestamp_ms <= $3::bigint
       GROUP BY width_bucket(a.timestamp_ms, $2::bigint, $3::bigint + 1, $4::int)
       ORDER BY 1`,
      [presaleId, fromMs, fromMs + span, PRESALE_RAISE_POINTS],
    ),
    bigWallets.length
      ? db.read<MarkerRow>(
        `SELECT e.occurred_at_ms::text AS t, e.actor, e.quote_amount::text AS quote_amount, e.usd::text AS usd,
           e.total_commitments_after::text AS total, NULL::text AS why, ${PERSON_COLUMNS}
         FROM (
           SELECT a.actor, a.timestamp_ms AS occurred_at_ms, a.quote_amount, a.total_commitments_after,
             ${commitUsdSql("a", "$2", "$3")} AS usd
           FROM chain_read_v1.activity a
           WHERE a.actor = ANY($6::text[]) AND a.presale_id = $1 AND a.kind = 'presale_commit' AND a.timestamp_ms <= $5::bigint
         ) e
         CROSS JOIN LATERAL (SELECT ${namedOwnerSql("e")} AS account_id) named
         ${identityJoinSql("named.account_id")}
         WHERE e.usd >= $4::numeric
         ORDER BY e.quote_amount DESC
         LIMIT 60`,
        [presaleId, row.stable, row.quote_decimals, PRESALE_BIG_COMMIT_USD, toMs, [...bigWallets]],
      )
      : null,
  ]);
  const markers = [
    ...(big?.rows ?? []).map((marker) => ({ ...marker, why: null })),
    ...theses.map((thesis) => ({ ...thesis, t: thesis.occurred_at_ms, why: thesis.text })),
  ];
  const seen = new Set<string>();
  return {
    points: points.rows.map((point) => [Number(point.t), atomsUsd(point.total, row, quoteUsd) ?? "0.00", point.total ?? "0"] as const),
    markers: markers
      .filter((marker) => {
        const key = `${marker.t}:${marker.actor}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((marker) => ({
        t: Number(marker.t),
        raised_usd: atomsUsd(marker.total, row, quoteUsd) ?? "0.00",
        commit_usd: marker.usd === null ? null : Number(marker.usd).toFixed(2),
        raised_atoms: marker.total ?? "0",
        commit_atoms: marker.quote_amount,
        wallet: marker.actor,
        account: personOf(marker),
        why: personOf(marker) ? marker.why : null,
      }))
      .sort((a, b) => a.t - b.t)
      .slice(0, 60),
  };
}

type EntryRow = Parameters<typeof entryFromRow>[0];

/**
 * The sale's activity tab: its posts (lifecycle, milestones, big commits) and
 * its named commits and claims, newest first, as feed items. The newest 150
 * entries are considered, so a stretch of anonymous commits ends the tab
 * there rather than scanning the sale's whole history.
 */
async function readActivity(
  db: ReadableDatabase,
  presaleId: string,
  config: SocialConfig,
  nowMs: number,
): Promise<FeedItem[]> {
  const { rows } = await db.read<EntryRow>(
    `SELECT e.*, named.account_id AS named_account_id
     FROM (
       SELECT f.entry_id, f.source, f.kind, f.product, f.occurred_at_ms, f.actor, f.presale_id, f.coin_type, f.digest,
         f.activity_id, f.quote_type, f.quote_amount, f.coin_amount, f.quote_refund, f.usd_value, f.usd_price_as_of_ms,
         f.milestone_value
       FROM social_feed_entries f
       WHERE f.presale_id = $3
       ORDER BY f.occurred_at_ms DESC
       LIMIT 150
     ) e
     CROSS JOIN LATERAL (SELECT ${namedOwnerSql("e")} AS account_id) named
     WHERE (${personEntrySql("e")} AND e.kind IN ('presale_commit', 'presale_claim') AND named.account_id IS NOT NULL)
       OR ${presalePostSql("e", "$1", "$2")}
     ORDER BY e.occurred_at_ms DESC, e.entry_id COLLATE "C" DESC
     LIMIT 30`,
    [config.big_commit_usd, config.big_trade_usd, presaleId],
  );
  return toItems(db, rows.map(entryFromRow), { nowMs, config });
}

type VestingRow = Readonly<{ share: string; asset: string; beneficiary: string; start_ms: string; cliff_end_ms: string; end_ms: string }>;

/** The span of `schedules` (OA-18): the earliest start and cliff end, the latest end; null for none. */
export function vestingSpan(schedules: readonly VestingRow[]): SocialPresaleVesting | null {
  if (schedules.length === 0) return null;
  return {
    start_ms: Math.min(...schedules.map((schedule) => Number(schedule.start_ms))),
    cliff_end_ms: Math.min(...schedules.map((schedule) => Number(schedule.cliff_end_ms))),
    end_ms: Math.max(...schedules.map((schedule) => Number(schedule.end_ms))),
  };
}

/** Token-recipient schedules only; buyer and quote schedules never move the team dates. */
export function teamVestingOf(terms: PresaleTerms | null, schedules: readonly VestingRow[]): SocialPresaleVesting | null {
  if (terms === null) return null;
  const team = new Set(terms.supply.recipients.map((recipient) => recipient.address));
  const own = schedules.filter((schedule) => team.has(schedule.beneficiary) && schedule.share === "token" && schedule.asset === "sale_token");
  if (own.length === 0) return null;
  const shape = (schedule: VestingRow) => `${Number(schedule.start_ms)}:${Number(schedule.cliff_end_ms)}:${Number(schedule.end_ms)}`;
  if (new Set(own.map(shape)).size > 1) return null;
  return vestingSpan(own);
}

type QuotePriceRow = Readonly<{ usd_price: string | null; as_of_ms: string | null }>;

export type PresaleTermsSource = (presaleId: string) => Promise<PresaleTerms | null>;

const usdPerTokenFormat = new Intl.NumberFormat("en-US", { useGrouping: false, maximumSignificantDigits: 12 });

/** USD per whole token as a decimal string (12 significant digits at most), or null. */
function perToken(usd: number, tokenAtoms: string, decimals: number): string | null {
  const tokens = Number(tokenAtoms) / 10 ** decimals;
  if (!(usd > 0) || !(tokens > 0)) return null;
  const price = usd / tokens;
  return Number.isFinite(price) && price > 0 ? usdPerTokenFormat.format(price) : null;
}

/** The projection's terms for the page: shares, each recipient's vesting, the presale and launch prices, and the pool's fee. */
export function termsOf(terms: PresaleTerms, row: Pick<SummaryRow, "target_usd" | "sale_decimals" | "quote_decimals" | "raise_target">, schedules: readonly VestingRow[]): SocialPresaleTerms {
  const recipient = (share: "token" | "raise") => (entry: PresaleTerms["supply"]["recipients"][number]) => ({ ...entry, vesting: vestingSpan(schedules.filter((schedule) => schedule.beneficiary === entry.address && schedule.share === share)) });
  const target = row.target_usd === null ? 0 : Number(row.target_usd);
  const poolBps = ratioBps(terms.raise.poolShare, terms.raiseTarget === "0" ? "1" : terms.raiseTarget);
  // The quote atoms the pool gets at the target: the terms' own `poolShare`, exact (scaled, floored to whole
  // atoms, only were the chain's target ever to differ from the terms'), never rounded through basis points.
  const poolAtoms = terms.raiseTarget === row.raise_target ? BigInt(terms.raise.poolShare)
    : terms.raiseTarget === "0" ? 0n : (BigInt(row.raise_target) * BigInt(terms.raise.poolShare)) / BigInt(terms.raiseTarget);
  return {
    supply: {
      total: terms.supply.total,
      participants: terms.supply.participants,
      liquidity: terms.supply.liquidity,
      recipients: terms.supply.recipients.map(recipient("token")),
      protocol: terms.supply.protocol,
    },
    raise: { pool_bps: poolBps, recipients: terms.raise.recipients.map(recipient("raise")), protocol: terms.raise.protocol },
    eligibility: terms.eligibility,
    ...(terms.publicBuy ? { public_buy: terms.publicBuy } : {}),
    ...(terms.eligibleUncappedFromMs === undefined ? {} : { eligible_uncapped_from_ms: terms.eligibleUncappedFromMs }),
    ...(terms.participantVesting === undefined ? {} : { buyer_vesting: terms.participantVesting === null ? null : { cliff_ms: terms.participantVesting.cliffMs, duration_ms: terms.participantVesting.durationMs } }),
    presale_price_usd: perToken(target, terms.supply.participants.amount, row.sale_decimals),
    launch_price_usd: perToken((target * poolBps) / 10_000, terms.supply.liquidity.amount, row.sale_decimals),
    presale_price_quote: quotePerToken(BigInt(row.raise_target), row.quote_decimals, terms.supply.participants.amount, row.sale_decimals),
    launch_price_quote: quotePerToken(poolAtoms, row.quote_decimals, terms.supply.liquidity.amount, row.sale_decimals),
    // Every token at that price: the pool's quote times the supply over the pool's tokens, as whole quote coins.
    launch_fdv_quote: /^[1-9][0-9]*$/.test(terms.supply.total)
      ? quotePerToken(poolAtoms * BigInt(terms.supply.total), row.quote_decimals, terms.supply.liquidity.amount, 0)
      : null,
    trading_fee_ppm: terms.poolFeePpm ?? null,
    burnable: terms.burnable,
    hard_cap: terms.hardCap,
  };
}

/**
 * Everything the sale page shows, from one database (the replica) at one
 * watermark. Null when `chain_read_v1.presales` has no such sale. Terms come
 * from `terms` (the presale projection) and are null when it fails.
 */
export async function readPresaleDetail(
  db: ReadableDatabase,
  presaleId: string,
  options: Readonly<{ asOf: AsOf; nowMs: number; config: SocialConfig; terms: PresaleTermsSource }>,
): Promise<SocialPresaleDetail | null> {
  const step = readSteps("presale");
  const [row] = await step("summary", () => readSummaries(db, [presaleId]));
  if (!row) return null;
  const { asOf, nowMs, config } = options;
  const endOfRaise = Math.min(asOf.timestamp_ms, nowMs, Number(row.end_ms));
  // Commitments open at the later of the share (`opened`) and the sale's start: a scheduled sale is shared before it.
  const startMs = Math.max(Number(row.opened_ms ?? 0), Number(row.start_ms));
  const [creator, quotePrice, momentum, backers, theses, activity, vesting, terms, buyerVesting] = await Promise.all([
    step("creator", () => db.read<PersonColumns & { wallet: string }>(
      `SELECT p.creator AS wallet, ${PERSON_COLUMNS}
       FROM ${SHOWN_PRESALES} p
       ${identityJoinSql(namedPositionSql("p.creator", "p.created_at_ms"))}
       WHERE p.presale_id = $1 AND p.creator IS NOT NULL`,
      [presaleId],
    )),
    row.stable
      ? Promise.resolve(null)
      : step("quote_price", () => db.read<QuotePriceRow>(
        `SELECT q.usd_price::text AS usd_price, q.as_of_ms::text AS as_of_ms FROM ${DISPLAY_PRICES} q
         JOIN ${SHOWN_PRESALES} p ON p.quote_type = q.coin_type WHERE p.presale_id = $1`,
        [presaleId],
      )),
    step("momentum", () => readMomentum(db, presaleId, row, Math.min(asOf.timestamp_ms, nowMs))),
    step("backers", () => readTopBackers(db, presaleId)),
    step("theses", () => readTheses(db, presaleId, row)),
    step("activity", () => readActivity(db, presaleId, config, nowMs)),
    step("vesting", () => db.read<VestingRow>(
      `SELECT v.share, v.asset, v.beneficiary, v.start_ms::text AS start_ms, ${vestingMsSql("v.start_ms + v.cliff_ms")} AS cliff_end_ms,
         ${vestingMsSql("v.end_ms")} AS end_ms
       FROM chain_read_v1.vesting_schedules v WHERE v.presale_id = $1 AND v.share <> 'participant'
       ORDER BY v.start_ms, v.schedule_id LIMIT 200`,
      [presaleId],
    )),
    step("terms", () => options.terms(presaleId)),
    step("buyer_vesting", () => db.read<NonNullable<SocialPresaleDetail["buyer_vesting"]> & { span: SocialPresaleVesting | null }>(
      `SELECT count(*) FILTER (WHERE share = 'participant' AND asset = 'sale_token')::int AS schedules,
         COALESCE(sum(total) FILTER (WHERE share = 'participant' AND asset = 'sale_token'), 0)::text AS total,
         COALESCE(sum(claimed) FILTER (WHERE share = 'participant' AND asset = 'sale_token'), 0)::text AS claimed,
         COALESCE(sum(total - claimed) FILTER (WHERE share = 'participant' AND asset = 'sale_token'), 0)::text AS remaining,
         CASE WHEN count(*) > 0 THEN jsonb_build_object(
           'start_ms', (${vestingMsSql("min(start_ms)")})::numeric,
           'cliff_end_ms', (${vestingMsSql("min(start_ms + cliff_ms)")})::numeric,
           'end_ms', (${vestingMsSql("max(end_ms)")})::numeric) END AS span
       FROM chain_read_v1.vesting_schedules WHERE presale_id = $1`,
      [presaleId],
    )),
  ]);
  const quoteUsd = row.stable ? 1 : quotePrice?.rows[0]?.usd_price ? Number(quotePrice.rows[0].usd_price) : null;
  // A commit worth marking as big belongs to a wallet holding at least that much; the largest wallets are read.
  const bigWallets = backers
    .filter((backer) => Number(atomsUsd(backer.commitment, row, quoteUsd) ?? 0) >= PRESALE_BIG_COMMIT_USD)
    .map((backer) => backer.wallet);
  const raise = await step("raise", () => readRaise(db, presaleId, row, startMs, endOfRaise, quoteUsd, bigWallets, theses));
  const schedules = vesting.rows;
  const saleTerms = terms ? termsOf(terms, row, schedules) : null;
  const summary = summaryOf(
    row,
    nowMs,
    saleTerms?.presale_price_usd ?? row.claimed_price_usd,
    saleTerms?.presale_price_quote ?? row.claimed_price_quote,
  );
  const priceRow = quotePrice?.rows[0];
  const top = backers.map((backer): SocialPresaleBacker => {
    const account = personOf(backer);
    return {
      wallet: backer.wallet,
      account,
      commitment_usd: atomsUsd(backer.commitment, row, quoteUsd),
      commitment_atoms: backer.commitment,
      share_bps: ratioBps(backer.commitment, row.total_commitments === "0" ? "1" : row.total_commitments),
      last_commit_ms: backer.last_commit_ms === null ? null : Number(backer.last_commit_ms),
      why: account ? backer.why : null,
    };
  });
  const top10 = backers.slice(0, 10).reduce((sum, backer) => sum + BigInt(backer.commitment), 0n);
  return {
    creator: creator.rows[0] ? { wallet: creator.rows[0].wallet, account: personOf(creator.rows[0]) } : null,
    presale: {
      ...summary,
      sale_token: row.sale_token,
      sale_decimals: row.sale_decimals,
      allowlisted: row.allowlisted,
      min_commitment_usd: row.min_commitment_usd,
      wallet_cap_usd: row.wallet_cap_usd,
      min_commitment_atoms: row.min_commitment_atoms,
      wallet_cap_atoms: row.wallet_cap_atoms,
      opened_ms: row.opened_ms === null ? null : Number(row.opened_ms),
    },
    quote_price: priceRow?.usd_price && priceRow.as_of_ms !== null
      ? { usd_price: priceRow.usd_price, as_of_ms: Number(priceRow.as_of_ms) }
      : null,
    momentum,
    backers: { top, top10_bps: row.total_commitments === "0" ? 0 : ratioBps(top10.toString(), row.total_commitments) },
    theses: theses.map((thesis): SocialPresaleThesis => ({
      why_id: thesis.why_id,
      entry_id: thesis.entry_id,
      account: personOf(thesis)!,
      text: thesis.text,
      commit_usd: thesis.usd === null ? null : Number(thesis.usd).toFixed(2),
      commit_atoms: thesis.quote_amount,
      rockets: thesis.rockets,
      occurred_at_ms: Number(thesis.occurred_at_ms),
    })),
    activity,
    raise,
    vesting: buyerVesting.rows[0]!.span,
    team_vesting: teamVestingOf(terms, schedules),
    buyer_vesting: { schedules: buyerVesting.rows[0]!.schedules, total: buyerVesting.rows[0]!.total, claimed: buyerVesting.rows[0]!.claimed, remaining: buyerVesting.rows[0]!.remaining },
    terms: saleTerms,
    as_of: asOf,
  };
}
