import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { z } from "zod";
import type { Pool } from "pg";
import { publicJson } from "@blast/core/lib/http-errors.ts";
import { readBondingFeatures } from "@blast/core/modules/launchpad-discovery/feature.ts";
import {
  autocommitReader,
  autocommitWrite,
} from "@blast/core/modules/database/transaction.ts";
import { BLAST_LAUNCH_COINS } from "@blast/server/modules/social/read-model/blast-launch-coins.ts";

const ID = z.string().regex(SUI_OBJECT_ID_PATTERN);
const HEADERS = { "Cache-Control": "no-store" };
const PAGE_SIZE = 100;
const ELIGIBLE = `(SELECT c.launch_id, coalesce(c.name, c.symbol) AS name, c.symbol, p.lifecycle
  FROM ${BLAST_LAUNCH_COINS} c
  JOIN chain_read_v1.pools p ON p.pool_id = c.launch_id AND p.venue = 'blast_curve'
  WHERE c.launch_id IS NOT NULL AND p.lifecycle IN ('opening_round', 'live', 'migration_ready', 'migrated'))`;
const changeSchema = z.strictObject({ launch_id: ID, pinned: z.boolean() });

function invalid(message: string) {
  return publicJson(
    { error: { code: "ADMIN_REQUEST_INVALID", message } },
    { status: 400, headers: HEADERS },
  );
}
async function list(request: Request, getPool: () => Pool): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const query = z
    .strictObject({ id: ID.nullable(), after: ID.nullable() })
    .safeParse({
      id: params.get("id")?.trim().toLowerCase() ?? null,
      after: params.get("after"),
    });
  if (!query.success)
    return invalid("Enter a full launch ID (0x and 64 hex characters).");
  const pool = getPool();
  const { rows } = await autocommitReader(pool, "launchpad-discovery").read(
    `SELECT * FROM ${ELIGIBLE} c WHERE ($1::text IS NULL OR launch_id = $1)
     AND ($2::text IS NULL OR launch_id > $2) ORDER BY launch_id LIMIT $3`,
    [query.data.id, query.data.after, PAGE_SIZE + 1],
  );
  const featured_launch_ids = await readBondingFeatures(pool);
  return publicJson(
    {
      curves: rows.slice(0, PAGE_SIZE),
      featured_launch_ids,
      next_cursor:
        rows.length > PAGE_SIZE ? rows[PAGE_SIZE - 1]!.launch_id : null,
    },
    { headers: HEADERS },
  );
}
async function save(request: Request, pool: () => Pool): Promise<Response> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return publicJson(
      { error: { code: "CONTENT_TYPE_INVALID", message: "Expected JSON." } },
      { status: 415, headers: HEADERS },
    );
  const text = await request.text();
  let value: unknown;
  try {
    value = text.length <= 256 ? JSON.parse(text) : null;
  } catch {
    value = null;
  }
  const change = changeSchema.safeParse(value);
  if (!change.success)
    return invalid("Expected a launch_id and a boolean pinned value.");
  const { launch_id, pinned } = change.data;
  const result = pinned
    ? await autocommitWrite(
        pool(),
        "launchpad-discovery",
        "mission_control_bonding_feature",
        `INSERT INTO mission_control_bonding_feature (launch_id)
       SELECT launch_id FROM ${ELIGIBLE} c WHERE launch_id = $1
       ON CONFLICT DO NOTHING`,
        [launch_id],
      )
    : await autocommitWrite(
        pool(),
        "launchpad-discovery",
        "mission_control_bonding_feature",
        "DELETE FROM mission_control_bonding_feature WHERE launch_id = $1",
        [launch_id],
      );
  if (
    pinned &&
    result.rowCount === 0 &&
    !(
      await autocommitReader(pool(), "launchpad-discovery").read(
        `SELECT 1 FROM ${ELIGIBLE} c WHERE launch_id = $1`,
        [launch_id],
      )
    ).rowCount
  )
    return publicJson(
      {
        error: {
          code: "not_found",
          message: "Choose a Blast bonding curve.",
        },
      },
      { status: 404, headers: HEADERS },
    );
  return publicJson(
    { featured_launch_ids: await readBondingFeatures(pool()) },
    { headers: HEADERS },
  );
}

/** Private operator capability; the admin website keeps the bearer server-side. */
export function createAdminBondingFeatureRoute(pool: () => Pool) {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method === "GET") return await list(request, pool);
      if (request.method === "POST") return await save(request, pool);
      return publicJson(
        { error: { code: "METHOD_NOT_ALLOWED", message: "Use GET or POST." } },
        { status: 405, headers: { ...HEADERS, Allow: "GET, POST" } },
      );
    } catch {
      return publicJson(
        {
          error: {
            code: "ADMIN_UNAVAILABLE",
            message:
              "Bonding banner is unavailable. Refresh to check the saved pins.",
          },
        },
        { status: 503, headers: HEADERS },
      );
    }
  };
}
