import { z } from "zod";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { socialOperatorCommand } from "./framework.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * R3-23 (OA-25 Q8): a sale's trust flags, `social_sale_trust` (0088).
 *
 *   sale trust set <presale_id> --audited --reason <text>
 *   sale trust clear <presale_id> --audited --reason <text>
 *   sale trust list [--after <presale_id>] [--limit <n>]
 *   sale trust history <presale_id> [--before <log_id>] [--limit <n>]
 *
 * `verified_team` (the pink mark) is set and cleared only from the admin
 * website (Jose 2026-11-21): its route runs these same `set` and `clear`
 * bodies with that flag (admin-verified/route.ts), and the CLI refuses
 * `--verified`. The web role may write only the verified columns (0165).
 *
 * `set` and `clear` require a reason (`reasonRequired`), and the framework
 * appends their one `social_operator_log` row (who, when, the reason, the
 * flags before and after) in the same transaction as the change: that
 * append-only log is the history, and `history` reads it back. The row keeps
 * the current state: each set flag's operator and time, and the last change's
 * reason as `note`, which no HTTP response ever carries.
 *
 * A flag already in the asked state is left as it is (its setter and time
 * stand) and the command is logged as a no-op. Only a sale the web shows can
 * be flagged; a row can be cleared even after its sale stopped showing.
 *
 * There is no LP-lock flag (OA-26): every Blast migration pool's LP position
 * is locked for good by the contracts, so every surface states the lock for
 * every sale and no operator records it.
 */

/** The flags the CLI may change; the verified mark is the admin website's alone. */
const CLI_FLAG_OPTIONS = Object.freeze({ "--audited": "audited" } as const);
export type TrustFlag = "verified_team" | "audited";
export type TrustFlags = Readonly<Record<TrustFlag, boolean>>;
/** Each flag's columns: the flag, who set it, when. */
const FLAG_COLUMNS = Object.freeze({
  verified_team: ["verified_team", "verified_by", "verified_at_ms"],
  audited: ["audited", "audited_by", "audited_at_ms"],
} as const);
const FLAG_NAMES = Object.keys(FLAG_COLUMNS) as TrustFlag[];

export const TRUST_LIST_DEFAULT_LIMIT = 50;
export const TRUST_LIST_MAX_LIMIT = 200;

/** A presale id as typed (trimmed, lowercased), or null. */
function presaleIdOf(raw: string | undefined): string | null {
  const id = raw?.trim().toLowerCase();
  const parsed = z.string().regex(SUI_OBJECT_ID_PATTERN).safeParse(id);
  return parsed.success ? parsed.data : null;
}

/** `<presale_id> --audited`: one id and at least one distinct CLI flag, nothing else. */
export function parseTrustChange(args: readonly string[]): { presaleId: string; flags: TrustFlag[] } | null {
  const presaleId = presaleIdOf(args[0]);
  if (!presaleId || args.length < 2) return null;
  const flags = new Set<TrustFlag>();
  for (const arg of args.slice(1)) {
    const flag = Object.hasOwn(CLI_FLAG_OPTIONS, arg) ? CLI_FLAG_OPTIONS[arg as keyof typeof CLI_FLAG_OPTIONS] : null;
    if (!flag || flags.has(flag)) return null;
    flags.add(flag);
  }
  return { presaleId, flags: [...flags] };
}

/** `--name value` options, each at most once and all known; null to refuse. */
export function options(args: readonly string[], known: readonly string[]): Map<string, string> | null {
  const out = new Map<string, string>();
  const allowed = new Set(known);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];
    if (!allowed.has(name) || value === undefined || out.has(name)) return null;
    out.set(name, value);
  }
  return out;
}

export function limitOf(raw: string | undefined): number | null {
  if (raw === undefined) return TRUST_LIST_DEFAULT_LIMIT;
  if (!z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().max(TRUST_LIST_MAX_LIMIT)).safeParse(raw).success) return null;
  return Number(raw);
}

export function parseTrustList(args: readonly string[]): { after: string | null; limit: number } | null {
  const parsed = options(args, ["--after", "--limit"]);
  if (!parsed) return null;
  const rawAfter = parsed.get("--after");
  const after = rawAfter === undefined ? null : presaleIdOf(rawAfter);
  const limit = limitOf(parsed.get("--limit"));
  if ((rawAfter !== undefined && after === null) || limit === null) return null;
  return { after, limit };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseTrustHistory(args: readonly string[]): { presaleId: string; before: string | null; limit: number } | null {
  const presaleId = presaleIdOf(args[0]);
  const parsed = options(args.slice(1), ["--before", "--limit"]);
  if (!presaleId || !parsed) return null;
  const before = parsed.get("--before")?.trim().toLowerCase() ?? null;
  const limit = limitOf(parsed.get("--limit"));
  if (!z.string().regex(UUID).nullable().safeParse(before).success || limit === null) return null;
  return { presaleId, before, limit };
}

type TrustRow = {
  presale_id: string;
  verified_team: boolean;
  audited: boolean;
  verified_by: string | null;
  verified_at_ms: string | null;
  audited_by: string | null;
  audited_at_ms: string | null;
  note: string | null;
  updated_at_ms: string;
};

const TRUST_COLUMNS = `presale_id, verified_team, audited, verified_by, verified_at_ms::text AS verified_at_ms,
  audited_by, audited_at_ms::text AS audited_at_ms, note, updated_at_ms::text AS updated_at_ms`;

export const NO_TRUST: TrustFlags = Object.freeze({ verified_team: false, audited: false });

function flagsOf(row: TrustRow | undefined): TrustFlags {
  return row ? { verified_team: row.verified_team, audited: row.audited } : NO_TRUST;
}

export type Change = { presaleId: string; flags: TrustFlag[] };

/**
 * One `set` or `clear`: lock the sale's row, read it, and write only the
 * changed flags' columns (a flag left alone keeps its setter and time), so the
 * admin route's role needs no grant on `audited` (0165).
 */
async function change(
  { presaleId, flags }: Change,
  to: boolean,
  context: Readonly<{ transaction: ModuleTransaction<"social">; operatorId: string; reason: string | null }>,
) {
  const { transaction, operatorId, reason } = context;
  // Serializes writers of one sale, including the first, which has no row to lock.
  await transaction.read("SELECT pg_advisory_xact_lock(hashtext('social_sale_trust:' || $1))", [presaleId]);
  const [row] = (await transaction.read<TrustRow>(`SELECT ${TRUST_COLUMNS} FROM social_sale_trust WHERE presale_id = $1`, [presaleId])).rows;
  if (to || !row) {
    // Only a sale the web shows can be flagged; a clear needs a row or a shown sale (then it is a no-op).
    const shown = await transaction.read(`SELECT 1 FROM ${SHOWN_PRESALES} p WHERE p.presale_id = $1`, [presaleId]);
    if (shown.rows.length === 0) throw new OperatorError("OPERATOR_TARGET_NOT_FOUND");
  }
  const before = flagsOf(row);
  const after: Record<TrustFlag, boolean> = { ...before };
  for (const flag of flags) after[flag] = to;
  const touched = FLAG_NAMES.filter((flag) => after[flag] !== before[flag]);
  const changed = touched.length > 0;
  if (changed) {
    // The transaction's own clock, so the row's times equal the log row's `acted_at`.
    const { rows } = await transaction.read<{ now_ms: string }>("SELECT (extract(epoch FROM now()) * 1000)::bigint::text AS now_ms");
    const nowMs = rows[0]!.now_ms;
    // A changed flag was off and is now on (this operator, now), or was on and is now off (nobody).
    const columns = [...touched.flatMap((flag) => FLAG_COLUMNS[flag]), "note", "updated_at_ms"];
    const values = [...touched.flatMap((flag) => (after[flag] ? [true, operatorId, nowMs] : [false, null, null])), reason, nowMs];
    const slots = columns.map((_, index) => `$${index + 2}`);
    await transaction.write(
      "social_sale_trust",
      row
        ? `UPDATE social_sale_trust SET ${columns.map((column, index) => `${column} = ${slots[index]}`).join(", ")} WHERE presale_id = $1`
        : `INSERT INTO social_sale_trust (presale_id, ${columns.join(", ")}) VALUES ($1, ${slots.join(", ")})`,
      [presaleId, ...values],
    );
  }
  return {
    result: { presale_id: presaleId, before, after, changed },
    log: { action: to ? "sale.trust.set" : "sale.trust.clear", target: presaleId, before, after },
  };
}

const CHANGE_USAGE = "<presale_id> --audited --reason <text>   (the reason is required; the Known deployer badge is set on the admin website)";

export const saleTrustSet = socialOperatorCommand<Change>({
  path: ["sale", "trust", "set"],
  usage: `sale trust set ${CHANGE_USAGE}`,
  reasonRequired: true,
  parse: parseTrustChange,
  run: (input, { operator, transaction, reason }) => change(input, true, { transaction, operatorId: operator.operatorId, reason }),
});

export const saleTrustClear = socialOperatorCommand<Change>({
  path: ["sale", "trust", "clear"],
  usage: `sale trust clear ${CHANGE_USAGE}`,
  reasonRequired: true,
  parse: parseTrustChange,
  run: (input, { operator, transaction, reason }) => change(input, false, { transaction, operatorId: operator.operatorId, reason }),
});

const msOrNull = (value: string | null) => (value === null ? null : Number(value));

/** `list`'s page: keyset on the primary key, never OFFSET. `$1` the last id shown (or null), `$2` the limit + 1. */
export const TRUST_LIST_SQL = `SELECT ${TRUST_COLUMNS} FROM social_sale_trust
  WHERE $1::text IS NULL OR presale_id COLLATE "C" > $1::text COLLATE "C"
  ORDER BY presale_id COLLATE "C"
  LIMIT $2`;

/**
 * `history`'s page: one sale's changes in the operator log, newest first,
 * keyset on (acted_at, log_id) through `social_operator_log_sale_trust_idx`
 * (0088), never OFFSET. `$1` the sale, `$2` the last log id shown (or null),
 * `$3` the limit + 1.
 */
export const TRUST_HISTORY_SQL = `SELECT l.log_id::text AS log_id, l.operator_id, l.action, l.before, l.after, l.reason, l.acted_at
  FROM social_operator_log l
  WHERE l.target = $1 AND l.action IN ('sale.trust.set', 'sale.trust.clear')
    AND ($2::uuid IS NULL OR (l.acted_at, l.log_id) < (SELECT c.acted_at, c.log_id FROM social_operator_log c WHERE c.log_id = $2::uuid))
  ORDER BY l.acted_at DESC, l.log_id DESC
  LIMIT $3`;

export const saleTrustList = socialOperatorCommand<{ after: string | null; limit: number }>({
  path: ["sale", "trust", "list"],
  usage: `sale trust list [--after <presale_id>] [--limit <1-${TRUST_LIST_MAX_LIMIT}>]   (every sale with a trust row, by id; --after pages)`,
  parse: parseTrustList,
  run: async ({ after, limit }, { transaction }) => {
    const { rows } = await transaction.read<TrustRow>(TRUST_LIST_SQL, [after, limit + 1]);
    const page = rows.slice(0, limit);
    return {
      result: {
        sales: page.map((row) => ({
          presale_id: row.presale_id,
          verified_team: row.verified_team,
          audited: row.audited,
          verified_by: row.verified_by,
          verified_at_ms: msOrNull(row.verified_at_ms),
          audited_by: row.audited_by,
          audited_at_ms: msOrNull(row.audited_at_ms),
          note: row.note,
          updated_at_ms: Number(row.updated_at_ms),
        })),
        next: rows.length > limit ? page.at(-1)!.presale_id : null,
      },
      log: { action: "sale.trust.list", target: after ?? "*", before: null, after: null },
    };
  },
});

type HistoryRow = { log_id: string; operator_id: string; action: string; before: unknown; after: unknown; reason: string | null; acted_at: Date };

export const saleTrustHistory = socialOperatorCommand<{ presaleId: string; before: string | null; limit: number }>({
  path: ["sale", "trust", "history"],
  usage: `sale trust history <presale_id> [--before <log_id>] [--limit <1-${TRUST_LIST_MAX_LIMIT}>]   (newest first; --before pages)`,
  parse: parseTrustHistory,
  run: async ({ presaleId, before, limit }, { transaction }) => {
    const { rows } = await transaction.read<HistoryRow>(TRUST_HISTORY_SQL, [presaleId, before, limit + 1]);
    const page = rows.slice(0, limit);
    return {
      result: {
        presale_id: presaleId,
        changes: page.map((row) => ({
          log_id: row.log_id,
          operator_id: row.operator_id,
          action: row.action,
          before: row.before,
          after: row.after,
          reason: row.reason,
          acted_at: row.acted_at.toISOString(),
        })),
        next: rows.length > limit ? page.at(-1)!.log_id : null,
      },
      log: { action: "sale.trust.history", target: presaleId, before: null, after: null },
    };
  },
});
