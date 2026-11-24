import { z } from "zod";
import type { Pool } from "pg";

import { publicJson } from "@blast/core/lib/http-errors.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { autocommitReader, withTransaction } from "@blast/core/modules/database/transaction.ts";
import { ADMIN_CONSOLE_OPERATOR } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { BLAST_LAUNCH_COINS } from "@blast/server/modules/social/read-model/blast-launch-coins.ts";
import { COIN_TRUST_HISTORY_SQL, coinTrustClear, coinTrustSet, coinTypeOf } from "../operator/coin-trust.ts";
import { runSocialOperatorInvocation, type SocialOperatorCommand } from "../operator/framework.ts";
import { TRUST_HISTORY_SQL, saleTrustClear, saleTrustSet } from "../operator/trust.ts";

/**
 * The admin website sets and clears the Known deployer badge for a
 * bonding-curve coin (`social_coin_trust`)
 * or a presale (`social_sale_trust.verified_team`). Each change runs the
 * operator command's own body and appends its `social_operator_log` row
 * (operator `admin-console`, the required reason) in one transaction.
 *
 *   GET                              every marked coin and presale, newest first
 *   GET ?kind=coin|presale&target=…  that target's last changes, newest first
 *   POST {kind, target, verified, reason}
 */

const HEADERS = { "Cache-Control": "no-store" };
const LIST_LIMIT = 200;
const HISTORY_LIMIT = 50;
const MAX_BODY = 2_048;

const kindSchema = z.enum(["coin", "presale"]);
type Kind = z.infer<typeof kindSchema>;
const changeSchema = z.strictObject({
  kind: kindSchema,
  target: z.string().max(1_100),
  verified: z.boolean(),
  // The framework's own reason rule: 1 to 500 characters, no control characters.
  reason: z.string().trim().min(1).max(500).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
});

/** A target in its canonical form, or null. */
function targetOf(kind: Kind, raw: string): string | null {
  if (kind === "coin") return coinTypeOf(raw);
  const id = raw.trim().toLowerCase();
  return SUI_OBJECT_ID_PATTERN.test(id) ? id : null;
}

function failure(status: number, code: string, message: string): Response {
  return publicJson({ error: { code, message } }, { status, headers: HEADERS });
}

const TARGET_HELP: Record<Kind, string> = {
  coin: "Enter a full coin type (0x…::module::NAME).",
  presale: "Enter a full presale ID (0x and 64 hex characters).",
};
const NOT_FOUND: Record<Kind, string> = {
  coin: "That is not a Blast bonding-curve coin. For a presale's coin, mark the presale.",
  presale: "That presale is not shown on Blast.",
};

type MarkRow = { target: string; name: string | null; symbol: string | null; verified_by: string; verified_at_ms: string; note: string | null };

const MARKED_COINS_SQL = `SELECT t.coin_type AS target, c.name, c.symbol, t.verified_by, t.verified_at_ms::text AS verified_at_ms, t.note
  FROM social_coin_trust t
  LEFT JOIN LATERAL (SELECT c.name, c.symbol FROM ${BLAST_LAUNCH_COINS} c WHERE c.coin_type = t.coin_type AND c.launch_id IS NOT NULL LIMIT 1) c ON TRUE
  ORDER BY t.verified_at_ms DESC, t.coin_type
  LIMIT $1`;
const MARKED_PRESALES_SQL = `SELECT t.presale_id AS target, p.sale_name AS name,
    coalesce(p.sale_symbol, split_part(p.sale_token, '::', 3)) AS symbol,
    t.verified_by, t.verified_at_ms::text AS verified_at_ms, t.note
  FROM social_sale_trust t
  LEFT JOIN chain_read_v1.presales p ON p.presale_id = t.presale_id
  WHERE t.verified_team
  ORDER BY t.verified_at_ms DESC, t.presale_id
  LIMIT $1`;

async function read(request: Request, pool: () => Pool): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const reader = () => autocommitReader(pool(), "social", { label: "social.admin_verified" });
  if (!params.has("kind") && !params.has("target")) {
    const [coins, presales] = await Promise.all([
      reader().read<MarkRow>(MARKED_COINS_SQL, [LIST_LIMIT + 1]),
      reader().read<MarkRow>(MARKED_PRESALES_SQL, [LIST_LIMIT + 1]),
    ]);
    const page = (rows: MarkRow[]) => rows.slice(0, LIST_LIMIT).map((row) => ({ ...row, verified_at_ms: Number(row.verified_at_ms) }));
    return publicJson({
      coins: page(coins.rows),
      presales: page(presales.rows),
      truncated: coins.rows.length > LIST_LIMIT || presales.rows.length > LIST_LIMIT,
    }, { headers: HEADERS });
  }
  const kind = kindSchema.safeParse(params.get("kind"));
  if (!kind.success) return failure(400, "ADMIN_REQUEST_INVALID", "Choose a coin or a presale.");
  const target = targetOf(kind.data, params.get("target") ?? "");
  if (!target) return failure(400, "ADMIN_REQUEST_INVALID", TARGET_HELP[kind.data]);
  const { rows } = await reader().read<{ log_id: string; operator_id: string; action: string; before: unknown; after: unknown; reason: string | null; acted_at: Date }>(
    kind.data === "coin" ? COIN_TRUST_HISTORY_SQL : TRUST_HISTORY_SQL,
    [target, null, HISTORY_LIMIT],
  );
  return publicJson({
    kind: kind.data,
    target,
    changes: rows.map((row) => ({ ...row, acted_at: row.acted_at.toISOString() })),
  }, { headers: HEADERS });
}

const COMMANDS: Record<Kind, Readonly<{ set: SocialOperatorCommand; clear: SocialOperatorCommand }>> = {
  coin: { set: coinTrustSet, clear: coinTrustClear },
  presale: { set: saleTrustSet, clear: saleTrustClear },
};

async function change(request: Request, pool: () => Pool): Promise<Response> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return failure(415, "CONTENT_TYPE_INVALID", "Expected JSON.");
  }
  const text = await request.text();
  let body: unknown;
  try {
    body = text.length <= MAX_BODY ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const parsed = changeSchema.safeParse(body);
  if (!parsed.success) {
    return failure(400, "ADMIN_REQUEST_INVALID", "Expected a coin or presale, a target, a boolean verified value and a reason (1 to 500 characters).");
  }
  const { kind, verified, reason } = parsed.data;
  const target = targetOf(kind, parsed.data.target);
  if (!target) return failure(400, "ADMIN_REQUEST_INVALID", TARGET_HELP[kind]);
  const input = kind === "coin" ? { coinType: target } : { presaleId: target, flags: ["verified_team"] };
  try {
    const outcome = await runSocialOperatorInvocation(
      { command: verified ? COMMANDS[kind].set : COMMANDS[kind].clear, input, reason },
      ADMIN_CONSOLE_OPERATOR,
      (operation, options) => withTransaction(pool(), operation, { label: "social.admin_verified", ...options }),
    );
    const { changed } = outcome.result as { changed: boolean };
    return publicJson({ kind, target, verified, changed, log_id: outcome.logId }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof OperatorError && error.code === "OPERATOR_TARGET_NOT_FOUND") return failure(404, "not_found", NOT_FOUND[kind]);
    if (error instanceof OperatorError && error.code === "OPERATOR_INPUT_INVALID") return failure(400, "ADMIN_REQUEST_INVALID", "The change was refused. Check the target and the reason.");
    throw error;
  }
}

/** Called only by the admin website's server; its bearer never reaches the browser. */
export function createAdminVerifiedMarkRoute(pool: () => Pool) {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method === "GET") return await read(request, pool);
      if (request.method === "POST") return await change(request, pool);
      return publicJson(
        { error: { code: "METHOD_NOT_ALLOWED", message: "Use GET or POST for this request." } },
        { status: 405, headers: { ...HEADERS, Allow: "GET, POST" } },
      );
    } catch {
      return failure(503, "ADMIN_UNAVAILABLE", "The Known deployer badge is unavailable. Refresh to check the saved state.");
    }
  };
}
