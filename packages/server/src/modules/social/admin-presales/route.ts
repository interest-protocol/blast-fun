import { readPinnablePresales, setPresalePin } from "./store.ts";
import { z } from "zod";

import { publicJson } from "@blast/core/lib/http-errors.ts";
import type { Pool } from "pg";

import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

const PAGE_SIZE = 100;
const HEADERS = { "Cache-Control": "no-store" };
type PinChange = { presale_id: string; pinned: boolean };

const pinChangeSchema = z.strictObject({ presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN), pinned: z.boolean() });

function isPinChange(body: unknown): body is PinChange {
  return pinChangeSchema.safeParse(body).success;
}

async function listPresales(request: Request, pool: () => Pool, nowMs: number): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const id = query.get("id")?.trim().toLowerCase() ?? null;
  const after = query.get("after");
  if (!z.object({ id: z.string().regex(SUI_OBJECT_ID_PATTERN).nullable(), after: z.string().regex(SUI_OBJECT_ID_PATTERN).nullable() }).safeParse({ id, after }).success) {
    return publicJson({ error: { code: "ADMIN_REQUEST_INVALID", message: "Enter a full presale ID (0x and 64 hex characters)." } }, { status: 400, headers: HEADERS });
  }
  const rows = await readPinnablePresales(pool(), { nowMs, id, after, limit: PAGE_SIZE + 1 });
  return publicJson({ presales: rows.slice(0, PAGE_SIZE), next_cursor: rows.length > PAGE_SIZE ? rows[PAGE_SIZE - 1]!.presale_id : null }, { headers: HEADERS });
}

/** Called only by the admin console's server; its bearer never reaches the browser. */
export function createAdminPresaleRoute(pool: () => Pool, now: () => number = Date.now) {
  return async (request: Request): Promise<Response> => {
    try {
      const nowMs = now();
      if (request.method === "GET") return await listPresales(request, pool, nowMs);
      if (request.method !== "POST") return publicJson({ error: { code: "METHOD_NOT_ALLOWED", message: "Use GET or POST for this request." } }, { status: 405, headers: { ...HEADERS, Allow: "GET, POST" } });
      if (!request.headers.get("content-type")?.startsWith("application/json")) {
        return publicJson({ error: { code: "CONTENT_TYPE_INVALID", message: "Expected JSON." } }, { status: 415, headers: HEADERS });
      }
      const text = await request.text();
      let body: unknown;
      try { body = text.length <= 256 ? JSON.parse(text) : null; } catch { body = null; }
      if (!isPinChange(body)) {
        return publicJson({ error: { code: "ADMIN_REQUEST_INVALID", message: "Expected a presale_id and a boolean pinned value." } }, { status: 400, headers: HEADERS });
      }
      if (!(await setPresalePin(pool(), body.presale_id, body.pinned, nowMs))) {
        return publicJson({ error: { code: "not_found", message: "Presale is not available for pinning." } }, { status: 404, headers: HEADERS });
      }
      return publicJson({ presale_id: body.presale_id, pinned: body.pinned }, { headers: HEADERS });
    } catch {
      return publicJson({ error: { code: "ADMIN_UNAVAILABLE", message: "Presales are unavailable. Refresh to check the saved state." } }, { status: 503, headers: HEADERS });
    }
  };
}
