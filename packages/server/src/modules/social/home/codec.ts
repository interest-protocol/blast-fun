import { z } from "zod";
import { socialCountSchema } from "@blast/core/modules/social/contracts/primitives.ts";

import { createHash } from "node:crypto";

import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

/**
 * Opaque keyset cursors: a JSON tuple as base64url, tagged by the read that
 * made it and carrying a check value, so an edited or borrowed cursor is
 * refused as `invalid_parameter` (`cursor`). A cursor names a position in a
 * public order and grants nothing; it never carries an account id.
 */
const MAX_LENGTH = 600;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function check(tag: string, body: string): string {
  return createHash("sha256").update(`social-home-${tag}:${body}`).digest("base64url").slice(0, 8);
}

export function encodeCursor(tag: string, values: readonly unknown[]): string {
  const body = Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
  return `${body}.${check(tag, body)}`;
}

export function invalidCursor(): SocialRouteError<"invalid_parameter"> {
  return new SocialRouteError("invalid_parameter", { extra: { parameter: "cursor" } });
}

/** The tuple a cursor of `tag` carries, or `invalid_parameter`; the caller checks each value. */
export function decodeCursor(tag: string, cursor: string): readonly unknown[] {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_LENGTH) throw invalidCursor();
  const [body, value, ...rest] = cursor.split(".");
  if (rest.length || !body || !value || !BASE64URL.test(body) || value !== check(tag, body)) throw invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const parsed = z.array(z.unknown()).safeParse(decoded);
  if (!parsed.success) throw invalidCursor();
  return parsed.data;
}

export const isCount = (value: unknown): value is number => socialCountSchema.safeParse(value).success;
export const isTime = (value: unknown): value is number | null => socialCountSchema.nullable().safeParse(value).success;
