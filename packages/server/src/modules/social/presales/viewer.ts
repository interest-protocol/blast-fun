import { DISPLAY_PRICES } from "@blast/core/modules/social/prices/test-sui.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  PRESALE_VIEWER_MAX_IDS,
  type PresaleListStatus,
  type SocialPresaleFollowedBacker,
  type SocialPresaleViewerEntry,
  type SocialPresaleViewerResponse,
} from "@blast/core/modules/social/contracts/presales.ts";
import {
  PERSON_COLUMNS,
  Params,
  addressesOfAccountsSql,
  firstCommitSql,
  latestThesisSql,
  personOf,
  quoteAtParSql,
  quoteUsdSql,
  usdSql,
  type PersonColumns,
} from "@blast/core/modules/social/presales/sql.ts";
import { readSummaries, statusFilterSql, summaryOf } from "@blast/server/modules/social/presales/summary.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { PRESALE_PAR_QUOTE_TYPES } from "@blast/core/modules/social/contracts/create.ts";

const MAX_FOLLOWED_PER_SALE = 100;
const MAX_COMMITS = 20;

type FollowedRow = PersonColumns & Readonly<{
  presale_id: string;
  account_id: string;
  commitment_usd: string | null;
  commitment_atoms: string;
  last_commit_ms: string;
  why: string | null;
  commits: [string, string | null, string][];
}>;

type MineRow = Readonly<{
  presale_id: string;
  commitment_usd: string | null;
  commitment_atoms: string;
  claimed: boolean;
  refund_usd: string | null;
  refund_atoms: string;
  claimable_tokens: string | null;
  claimed_tokens: string;
  claim_wallet_claimed: boolean;
  claim_wallet_commitment_atoms: string;
  claim_wallet_participated: boolean;
  buyer_vesting: NonNullable<SocialPresaleViewerEntry["mine"]>["buyer_vesting"];
  commits: [string, string | null, string][];
}>;

/** Read each wallet's newest commits by its activity index before taking the sale-wide limit. */
function recentCommitsSql(wallets: string, presale: string, stable: string, decimals: string): string {
  return `(SELECT COALESCE(json_agg(json_build_array(c.timestamp_ms::text, c.usd, c.atoms) ORDER BY c.timestamp_ms), '[]'::json)
    FROM (
      SELECT a.timestamp_ms, round(CASE WHEN ${stable} THEN a.quote_amount / (10::numeric ^ ${decimals})
        ELSE a.usd_value END, 2)::text AS usd, a.quote_amount::text AS atoms
      FROM unnest(${wallets}) AS w(wallet)
      CROSS JOIN LATERAL (
        SELECT a.timestamp_ms, a.quote_amount, a.usd_value
        FROM chain_read_v1.activity a
        WHERE a.actor = w.wallet AND a.presale_id = ${presale} AND a.kind = 'presale_commit'
        ORDER BY a.timestamp_ms DESC LIMIT ${MAX_COMMITS}
      ) a
      ORDER BY a.timestamp_ms DESC LIMIT ${MAX_COMMITS}
    ) c)`;
}

/**
 * The positions of the accounts `viewer` follows, per presale and account,
 * named by the position rule (an account that is private or started sharing
 * after its first commit to the sale is left out), in `presales` (a text[]
 * placeholder) or, when `presales` is null, in the presales of `status`.
 */
function followedSql(params: Params, viewer: string, scope: string): string {
  const parQuotes = params.add(PRESALE_PAR_QUOTE_TYPES);
  const followed = `ARRAY(SELECT f.target_id::uuid FROM social_follows f
      WHERE f.follower_account_id = ${viewer}::uuid AND f.target_kind = 'account')`;
  const held = `SELECT pp.presale_id, o.account_id, pp.wallet, pp.commitment, pp.last_commit_ms, p.quote_decimals,
        ${quoteAtParSql(parQuotes)} AS stable, ${quoteUsdSql(parQuotes)} AS quote_usd
      FROM (${addressesOfAccountsSql(followed)}) o
      JOIN social_accounts account ON account.account_id = o.account_id
      JOIN chain_read_v1.presale_positions pp ON pp.wallet = o.address
      JOIN ${SHOWN_PRESALES} p ON p.presale_id = pp.presale_id
      LEFT JOIN ${DISPLAY_PRICES} qp ON qp.coin_type = p.quote_type
      WHERE ${scope} AND account.privacy = 'public' AND account.sharing_since IS NOT NULL AND o.linked_at IS NOT NULL
        AND extract(epoch FROM greatest(account.sharing_since, o.linked_at)) * 1000 <= ${firstCommitSql("pp.wallet", "pp.presale_id")}`;
  return `
    SELECT n.presale_id, n.account_id::text AS account_id, ${PERSON_COLUMNS},
      round(sum(n.commitment) / (10::numeric ^ n.quote_decimals) * n.quote_usd, 2)::text AS commitment_usd,
      sum(n.commitment)::text AS commitment_atoms,
      max(n.last_commit_ms)::text AS last_commit_ms,
      ${latestThesisSql("n.presale_id", "n.account_id")} AS why,
      ${recentCommitsSql("array_agg(n.wallet)", "n.presale_id", "n.stable", "n.quote_decimals")} AS commits
    FROM (${held}) n
    LEFT JOIN social_account_identities i ON i.account_id = n.account_id
    GROUP BY n.presale_id, n.account_id, n.quote_decimals, n.stable, n.quote_usd,
      i.callsign, i.display_name, i.avatar_url, i.x_handle`;
}

/** The caller's own positions in `presales` over `addresses` (text[] placeholders). */
function mineSql(params: Params, addresses: string, presales: string, claimWallet: string | null): string {
  const parQuotes = params.add(PRESALE_PAR_QUOTE_TYPES);
  const wallet = params.add(claimWallet);
  return `SELECT pp.presale_id,
      ${usdSql("sum(pp.commitment)", parQuotes)} AS commitment_usd,
      sum(pp.commitment)::text AS commitment_atoms,
      COALESCE(max(pp.commitment) FILTER (WHERE pp.wallet = ${wallet}), 0)::text AS claim_wallet_commitment_atoms,
      bool_and(pp.claim_digest IS NOT NULL) AS claimed,
      ${usdSql("sum(COALESCE(pp.claimed_quote_refund, 0))", parQuotes)} AS refund_usd,
      sum(COALESCE(pp.claimed_quote_refund, 0))::text AS refund_atoms,
      max(CASE WHEN pp.wallet = ${wallet} THEN CASE WHEN pp.claim_digest IS NULL THEN pp.claimable_tokens ELSE 0 END END)::text AS claimable_tokens,
      sum(COALESCE(pp.claimed_tokens, 0))::text AS claimed_tokens,
      COALESCE(bool_or(pp.wallet = ${wallet}), false) AS claim_wallet_participated,
      COALESCE(bool_or(pp.wallet = ${wallet} AND pp.claim_digest IS NOT NULL), false) AS claim_wallet_claimed,
      (jsonb_agg(jsonb_build_object('schedule_id', v.schedule_id, 'beneficiary', v.beneficiary,
        'total', v.total::text, 'claimed', v.claimed::text, 'remaining', (v.total - v.claimed)::text))
        FILTER (WHERE pp.wallet = ${wallet} AND v.schedule_id IS NOT NULL))->0 AS buyer_vesting,
      ${recentCommitsSql(`${addresses}::text[]`, "pp.presale_id", quoteAtParSql(parQuotes), "p.quote_decimals")} AS commits
    FROM chain_read_v1.presale_positions pp
    JOIN ${SHOWN_PRESALES} p ON p.presale_id = pp.presale_id
    LEFT JOIN chain_read_v1.vesting_schedules v ON v.schedule_id = pp.claim_vesting_id
      AND v.presale_id = pp.presale_id AND v.beneficiary = pp.wallet AND v.share = 'participant' AND v.asset = 'sale_token'
    LEFT JOIN ${DISPLAY_PRICES} qp ON qp.coin_type = p.quote_type
    WHERE pp.wallet = ANY(${addresses}::text[]) AND pp.presale_id = ANY(${presales}::text[])
    GROUP BY pp.presale_id, p.quote_decimals, p.quote_type, qp.usd_price`;
}

/** Dollars summed to the cent; unknown when any part is (a SUI commitment without a SUI price): never a smaller total. */
const sumUsd = (values: readonly (string | null)[]): string | null =>
  values.some((value) => value === null) ? null : values.reduce((sum, value) => sum + Number(value), 0).toFixed(2);

/** Quote atoms of one sale summed exactly (one sale, one unit). */
const sumAtoms = (values: readonly string[]) => values.reduce((sum, value) => sum + BigInt(value), 0n).toString();

function entries(followed: readonly FollowedRow[], mine: readonly MineRow[], presaleIds: readonly string[], includeCommitFields = false) {
  const presales: Record<string, SocialPresaleViewerEntry> = {};
  const ownByPresale = new Map<string, MineRow>();
  for (const row of mine) if (!ownByPresale.has(row.presale_id)) ownByPresale.set(row.presale_id, row);
  for (const id of presaleIds) {
    const rows = followed
      .filter((row) => row.presale_id === id)
      .map((row): SocialPresaleFollowedBacker => ({
        account: personOf(row)!,
        commitment_usd: row.commitment_usd,
        commitment_atoms: row.commitment_atoms,
        last_commit_ms: Number(row.last_commit_ms),
        why: row.why,
        commits: row.commits.map(([t, usd, atoms]) => [Number(t), usd, atoms] as const).reverse(),
      }))
      .filter((row) => row.account)
      // Largest first in the sale's own atoms: one sale, one unit, and a SUI sale without a price still orders.
      .sort((a, b) => {
        const left = BigInt(a.commitment_atoms);
        const right = BigInt(b.commitment_atoms);
        return left === right ? a.account.callsign.localeCompare(b.account.callsign) : left < right ? 1 : -1;
      })
      .slice(0, MAX_FOLLOWED_PER_SALE);
    const own = ownByPresale.get(id);
    presales[id] = {
      following: rows,
      following_total_usd: sumUsd(rows.map((row) => row.commitment_usd)),
      following_total_atoms: sumAtoms(rows.map((row) => row.commitment_atoms)),
      mine: own
        ? {
          commitment_usd: own.commitment_usd,
          commitment_atoms: own.commitment_atoms,
          commits: own.commits.map(([t, usd, atoms]) => [Number(t), usd, atoms] as const).reverse(),
          claimed: own.claimed,
          refund_usd: own.refund_usd,
          refund_atoms: own.refund_atoms,
          claimable_tokens: own.claimable_tokens,
          claimed_tokens: own.claimed_tokens,
          claim_wallet_claimed: own.claim_wallet_claimed,
          ...(includeCommitFields ? { claim_wallet_commitment_atoms: own.claim_wallet_commitment_atoms } : {}),
          claim_wallet_participated: own.claim_wallet_participated,
          buyer_vesting: own.buyer_vesting,
        }
        : null,
    };
  }
  return presales;
}

/**
 * The caller's view of `presaleIds`: the accounts they follow that backed each
 * (named only) and their own position over `ownAddresses`.
 */
export async function readViewerPresales(
  db: ReadableDatabase,
  viewerAccountId: string,
  ownAddresses: readonly string[],
  presaleIds: readonly string[],
  claimWallet: string | null = ownAddresses.length === 1 ? ownAddresses[0]! : null,
  includeCommitFields = false,
  optionalFollowing?: Readonly<{ database: ReadableDatabase; onUnavailable: () => void }>,
): Promise<SocialPresaleViewerResponse> {
  const ids = [...new Set(presaleIds)];
  const followedParams = new Params();
  const viewer = followedParams.add(viewerAccountId);
  const scope = `pp.presale_id = ANY(${followedParams.add(ids)}::text[])`;
  const mineParams = new Params();
  const addresses = mineParams.add([...new Set(ownAddresses)]);
  const presales = mineParams.add(ids);
  const [mine, followed] = await Promise.all([
    ownAddresses.length ? db.read<MineRow>(mineSql(mineParams, addresses, presales, claimWallet), mineParams.values) : null,
    (optionalFollowing?.database ?? db)
      .read<FollowedRow>(followedSql(followedParams, viewer, scope), followedParams.values)
      .then((result) => result.rows)
      .catch((error: unknown) => {
        if (!optionalFollowing) throw error;
        optionalFollowing.onUnavailable();
        return [];
      }),
  ]);
  return { presales: entries(followed, mine?.rows ?? [], ids, includeCommitFields), rows: null };
}

/**
 * "Backed by people you follow": the presales of `status` that accounts the
 * caller follows backed (named), most such accounts first, then most raised;
 * at most `PRESALE_VIEWER_MAX_IDS`, with their rows and the caller's view.
 */
export async function readViewerBackedPresales(
  db: ReadableDatabase,
  viewerAccountId: string,
  ownAddresses: readonly string[],
  status: PresaleListStatus,
  nowMs: number,
  claimWallet: string | null = ownAddresses.length === 1 ? ownAddresses[0]! : null,
  followingDatabase: ReadableDatabase = db,
): Promise<SocialPresaleViewerResponse> {
  const params = new Params();
  const viewer = params.add(viewerAccountId);
  const scope = statusFilterSql(status, () => `${params.add(nowMs)}::bigint`);
  const followed = await followingDatabase.read<FollowedRow>(followedSql(params, viewer, scope), params.values);
  const counts = new Map<string, number>();
  for (const row of followed.rows) counts.set(row.presale_id, (counts.get(row.presale_id) ?? 0) + 1);
  const summaries = await readSummaries(db, [...counts.keys()]);
  const ordered = summaries
    .sort((a, b) =>
      (counts.get(b.presale_id) ?? 0) - (counts.get(a.presale_id) ?? 0) ||
      Number(b.raised_usd ?? 0) - Number(a.raised_usd ?? 0) ||
      a.presale_id.localeCompare(b.presale_id))
    .slice(0, PRESALE_VIEWER_MAX_IDS);
  const ids = ordered.map((row) => row.presale_id);
  const mineParams = new Params();
  const addresses = mineParams.add([...new Set(ownAddresses)]);
  const presales = mineParams.add(ids);
  const mine = ownAddresses.length && ids.length
    ? await db.read<MineRow>(mineSql(mineParams, addresses, presales, claimWallet), mineParams.values)
    : null;
  const shownIds = new Set(ids);
  return {
    presales: entries(followed.rows.filter((row) => shownIds.has(row.presale_id)), mine?.rows ?? [], ids),
    rows: ordered.map((row) => summaryOf(row, nowMs)),
  };
}

type MineIdRow = Readonly<{ presale_id: string }>;

/**
 * "Your presales": every sale the caller's wallets committed to, newest
 * commit first (at most `PRESALE_VIEWER_MAX_IDS`), with their rows and the
 * caller's position in each.
 */
export async function readViewerOwnPresales(
  db: ReadableDatabase,
  ownAddresses: readonly string[],
  nowMs: number,
  claimWallet: string | null = ownAddresses.length === 1 ? ownAddresses[0]! : null,
): Promise<SocialPresaleViewerResponse> {
  if (ownAddresses.length === 0) return { presales: {}, rows: [] };
  const { rows: idRows } = await db.read<MineIdRow>(
    `SELECT pp.presale_id FROM chain_read_v1.presale_positions pp
     WHERE pp.wallet = ANY($1::text[])
     GROUP BY pp.presale_id
     ORDER BY max(pp.last_commit_ms) DESC NULLS LAST, pp.presale_id
     LIMIT $2`,
    [[...ownAddresses], PRESALE_VIEWER_MAX_IDS],
  );
  const ids = idRows.map((row) => row.presale_id);
  if (ids.length === 0) return { presales: {}, rows: [] };
  const params = new Params();
  const addresses = params.add([...new Set(ownAddresses)]);
  const presales = params.add(ids);
  const [summaries, mine] = await Promise.all([
    readSummaries(db, ids),
    db.read<MineRow>(mineSql(params, addresses, presales, claimWallet), params.values),
  ]);
  const order = new Map(ids.map((id, index) => [id, index]));
  return {
    presales: entries([], mine.rows, ids),
    rows: summaries.sort((a, b) => (order.get(a.presale_id) ?? 0) - (order.get(b.presale_id) ?? 0)).map((row) => summaryOf(row, nowMs)),
  };
}
