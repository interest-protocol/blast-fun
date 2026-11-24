import { normalizeStructTag } from "@mysten/sui/utils";
import { z } from "zod";
import { COIN_TYPE_WITH_GENERICS } from "@blast/core/lib/sui/ids.ts";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { BLAST_LAUNCH_COINS } from "@blast/server/modules/social/read-model/blast-launch-coins.ts";
import { socialOperatorCommand } from "./framework.ts";
import { TRUST_LIST_MAX_LIMIT, UUID, limitOf, options } from "./trust.ts";

/**
 * R3-23 for bonding-curve coins (Jose 2026-11-20): Blast checked who is behind
 * a curve coin, `social_coin_trust` (0164). `coinTrustSet` and `coinTrustClear`
 * are the only writers, and only the admin website's route runs them (Jose
 * 2026-11-21, admin-verified/route.ts); the CLI keeps the reads:
 *
 *   coin trust list [--after <coin_type>] [--limit <n>]
 *   coin trust history <coin_type> [--before <log_id>] [--limit <n>]
 *
 * A row means verified; `clear` deletes it. The framework appends one
 * `social_operator_log` row per command in the same transaction, which is the
 * history. Only a Blast curve coin can be set; a sale's coin uses `sale trust`,
 * so each coin has one flag. A row can be cleared whatever the coin's state.
 */

/** A coin type as typed, in its canonical form (full addresses), or null. */
export function coinTypeOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const coinType = normalizeStructTag(raw.trim());
    return coinType.length <= 1024 && COIN_TYPE_WITH_GENERICS.test(coinType) ? coinType : null;
  } catch {
    return null;
  }
}

export function parseCoinTrustChange(args: readonly string[]): { coinType: string } | null {
  const coinType = args.length === 1 ? coinTypeOf(args[0]) : null;
  return coinType ? { coinType } : null;
}

export function parseCoinTrustList(args: readonly string[]): { after: string | null; limit: number } | null {
  const parsed = options(args, ["--after", "--limit"]);
  if (!parsed) return null;
  const rawAfter = parsed.get("--after");
  const after = rawAfter === undefined ? null : coinTypeOf(rawAfter);
  const limit = limitOf(parsed.get("--limit"));
  if ((rawAfter !== undefined && after === null) || limit === null) return null;
  return { after, limit };
}

export function parseCoinTrustHistory(args: readonly string[]): { coinType: string; before: string | null; limit: number } | null {
  const coinType = coinTypeOf(args[0]);
  const parsed = options(args.slice(1), ["--before", "--limit"]);
  if (!coinType || !parsed) return null;
  const before = parsed.get("--before")?.trim().toLowerCase() ?? null;
  const limit = limitOf(parsed.get("--limit"));
  if (!z.string().regex(UUID).nullable().safeParse(before).success || limit === null) return null;
  return { coinType, before, limit };
}

type Flag = Readonly<{ verified_team: boolean }>;

async function change(
  coinType: string,
  to: boolean,
  { transaction, operatorId, reason }: Readonly<{ transaction: ModuleTransaction<"social">; operatorId: string; reason: string | null }>,
) {
  // Serializes writers of one coin, including the first, which has no row to lock.
  await transaction.read("SELECT pg_advisory_xact_lock(hashtext('social_coin_trust:' || $1))", [coinType]);
  const exists = (await transaction.read("SELECT 1 FROM social_coin_trust WHERE coin_type = $1", [coinType])).rows.length > 0;
  if (to && !exists) {
    const curve = await transaction.read(`SELECT 1 FROM ${BLAST_LAUNCH_COINS} c WHERE c.coin_type = $1 AND c.launch_id IS NOT NULL`, [coinType]);
    if (curve.rows.length === 0) throw new OperatorError("OPERATOR_TARGET_NOT_FOUND");
    await transaction.write(
      "social_coin_trust",
      `INSERT INTO social_coin_trust (coin_type, verified_by, verified_at_ms, note)
       VALUES ($1, $2, (extract(epoch FROM now()) * 1000)::bigint, $3)`,
      [coinType, operatorId, reason],
    );
  }
  if (!to && exists) await transaction.write("social_coin_trust", "DELETE FROM social_coin_trust WHERE coin_type = $1", [coinType]);
  const before: Flag = { verified_team: exists };
  const after: Flag = { verified_team: to };
  return {
    result: { coin_type: coinType, before, after, changed: exists !== to },
    log: { action: to ? "coin.trust.set" : "coin.trust.clear", target: coinType, before, after },
  };
}

const CHANGE_USAGE = "<coin_type> --reason <text>   (a Blast bonding-curve coin; the reason is required)";

export const coinTrustSet = socialOperatorCommand<{ coinType: string }>({
  path: ["coin", "trust", "set"],
  usage: `coin trust set ${CHANGE_USAGE}`,
  reasonRequired: true,
  parse: parseCoinTrustChange,
  run: ({ coinType }, { operator, transaction, reason }) => change(coinType, true, { transaction, operatorId: operator.operatorId, reason }),
});

export const coinTrustClear = socialOperatorCommand<{ coinType: string }>({
  path: ["coin", "trust", "clear"],
  usage: `coin trust clear ${CHANGE_USAGE}`,
  reasonRequired: true,
  parse: parseCoinTrustChange,
  run: ({ coinType }, { operator, transaction, reason }) => change(coinType, false, { transaction, operatorId: operator.operatorId, reason }),
});

/** `list`'s page: keyset on the primary key. `$1` the last coin shown (or null), `$2` the limit + 1. */
export const COIN_TRUST_LIST_SQL = `SELECT coin_type, verified_by, verified_at_ms::text AS verified_at_ms, note FROM social_coin_trust
  WHERE $1::text IS NULL OR coin_type COLLATE "C" > $1::text COLLATE "C"
  ORDER BY coin_type COLLATE "C"
  LIMIT $2`;

/** `history`'s page through `social_operator_log_coin_trust_idx` (0164), newest first, keyset on (acted_at, log_id). */
export const COIN_TRUST_HISTORY_SQL = `SELECT l.log_id::text AS log_id, l.operator_id, l.action, l.before, l.after, l.reason, l.acted_at
  FROM social_operator_log l
  WHERE l.target = $1 AND l.action IN ('coin.trust.set', 'coin.trust.clear')
    AND ($2::uuid IS NULL OR (l.acted_at, l.log_id) < (SELECT c.acted_at, c.log_id FROM social_operator_log c WHERE c.log_id = $2::uuid))
  ORDER BY l.acted_at DESC, l.log_id DESC
  LIMIT $3`;

export const coinTrustList = socialOperatorCommand<{ after: string | null; limit: number }>({
  path: ["coin", "trust", "list"],
  usage: `coin trust list [--after <coin_type>] [--limit <1-${TRUST_LIST_MAX_LIMIT}>]   (every verified curve coin; --after pages)`,
  parse: parseCoinTrustList,
  run: async ({ after, limit }, { transaction }) => {
    const { rows } = await transaction.read<{ coin_type: string; verified_by: string; verified_at_ms: string; note: string }>(
      COIN_TRUST_LIST_SQL,
      [after, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      result: {
        coins: page.map((row) => ({ ...row, verified_at_ms: Number(row.verified_at_ms) })),
        next: rows.length > limit ? page.at(-1)!.coin_type : null,
      },
      log: { action: "coin.trust.list", target: after ?? "*", before: null, after: null },
    };
  },
});

type HistoryRow = { log_id: string; operator_id: string; action: string; before: unknown; after: unknown; reason: string | null; acted_at: Date };

export const coinTrustHistory = socialOperatorCommand<{ coinType: string; before: string | null; limit: number }>({
  path: ["coin", "trust", "history"],
  usage: `coin trust history <coin_type> [--before <log_id>] [--limit <1-${TRUST_LIST_MAX_LIMIT}>]   (newest first; --before pages)`,
  parse: parseCoinTrustHistory,
  run: async ({ coinType, before, limit }, { transaction }) => {
    const { rows } = await transaction.read<HistoryRow>(COIN_TRUST_HISTORY_SQL, [coinType, before, limit + 1]);
    const page = rows.slice(0, limit);
    return {
      result: {
        coin_type: coinType,
        changes: page.map((row) => ({ ...row, acted_at: row.acted_at.toISOString() })),
        next: rows.length > limit ? page.at(-1)!.log_id : null,
      },
      log: { action: "coin.trust.history", target: coinType, before: null, after: null },
    };
  },
});
