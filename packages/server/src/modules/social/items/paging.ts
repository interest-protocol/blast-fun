import { socialParameter } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import { socialCountSchema } from "@blast/core/modules/social/contracts/primitives.ts";

import { createHash } from "node:crypto";

import { ITEM_PAGE_DEFAULT_LIMIT, ITEM_PAGE_MAX_LIMIT } from "@blast/core/modules/social/contracts/items.ts";
import { entryIdBranch, type EntryCursor } from "@blast/core/modules/social/read-model/entries.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

/**
 * Item paging: the opaque page cursor and the `limit` parameter.
 *
 * A cursor is the sort key of a page's last entry (`occurred_at_ms`, then
 * `entry_id`), the read model's keyset, as base64url text carrying a version
 * and a check value. The check value catches an edited or truncated cursor;
 * it is not a secret, and a cursor grants nothing: it only names a position
 * in a public order. Clients pass it back unchanged and never parse it.
 */

const VERSION = 1;
const CHECK_BYTES = 6;
/** Ample for a 512-character entry id; anything longer is not a cursor. */
const MAX_CURSOR_LENGTH = 1_024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const LIMIT = /^[1-9][0-9]{0,2}$/;

function check(body: string): string {
  return createHash("sha256").update(`social-feed-cursor:${body}`).digest("base64url").slice(0, (CHECK_BYTES * 4) / 3);
}

/** The cursor that resumes after `position` (pass the page's last entry). */
export function encodeItemCursor(position: EntryCursor): string {
  const body = Buffer.from(JSON.stringify([VERSION, position.occurredAtMs, position.entryId]), "utf8").toString("base64url");
  return `${body}.${check(body)}`;
}

function invalidCursor(): SocialRouteError<"invalid_parameter"> {
  return new SocialRouteError("invalid_parameter", { extra: { parameter: "cursor" } });
}

/** The position a cursor names; `invalid_parameter` (parameter `cursor`) for anything this codec did not produce. */
const itemCursorSchema = z.tuple([
  z.literal(VERSION),
  socialCountSchema,
  z.string().refine((value) => entryIdBranch(value) !== null),
]);

export function decodeItemCursor(cursor: string): EntryCursor {
  if (typeof cursor !== "string" || cursor.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  const [body, value, ...rest] = cursor.split(".");
  if (rest.length || !body || !value || !BASE64URL.test(body) || value !== check(body)) throw invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const parsed = itemCursorSchema.safeParse(decoded);
  if (!parsed.success) throw invalidCursor();
  const [, occurredAtMs, entryId] = parsed.data;
  return { occurredAtMs, entryId };
}

/** `limit`: absent means 20; otherwise an integer from 1 to 50, else `invalid_parameter` (parameter `limit`). */
export function parseItemLimit(raw: string | null | undefined): number {
  return socialParameter(
    z.string().regex(LIMIT).transform(Number).pipe(z.number().int().min(1).max(ITEM_PAGE_MAX_LIMIT))
      .nullish().transform((value) => value ?? ITEM_PAGE_DEFAULT_LIMIT),
    raw,
    "limit",
  );
}

export type ItemPageRequest = Readonly<{ limit: number; before: EntryCursor | null }>;

/** A page request from a route's query: `limit` and `cursor` (both optional). */
export function parseItemPage(searchParams: URLSearchParams): ItemPageRequest {
  const cursor = searchParams.get("cursor");
  return {
    limit: parseItemLimit(searchParams.get("limit")),
    before: cursor === null ? null : decodeItemCursor(cursor),
  };
}

/**
 * The next page's cursor: the last entry's position when the selection
 * filled the page (`entries.length >= limit`), else null. Pass the selection's
 * entries, not the mapped items: the mapper may drop an entry it must not show.
 */
export function nextItemCursor(entries: readonly { occurredAtMs: number; entryId: string }[], limit: number): string | null {
  const last = entries.at(-1);
  return last && entries.length >= limit ? encodeItemCursor({ occurredAtMs: last.occurredAtMs, entryId: last.entryId }) : null;
}
