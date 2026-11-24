import { z } from "zod";

/**
 * The shared page-token envelope for `/api/launchpad` lists. Each projection
 * defines its own ordered key; the envelope carries it with a deterministic
 * tie-break (never empty, such as a launch or pool id) so equal keys always
 * order the same way, binds the token to its scope (the list and its sort),
 * and stays opaque and bounded. It aligns with blast-infra's `/v1` page
 * tokens: a token belongs to its sort, limits clamp rather than fail, and an
 * invalid token is a 400.
 */

export class CursorError extends Error {
  readonly code = "LAUNCHPAD_CURSOR_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

/** A key part: a decimal string (exact atomic or bigint value) or a JSON safe integer. */
export type KeyPart = "decimal" | "integer";

export type CursorShape = Readonly<{
  /** The list and its order, such as `launches:volume_24h`. A token of another scope is invalid. */
  scope: string;
  /** The projection's ordered key, part by part. */
  key: readonly KeyPart[];
  /**
   * How many tie-break strings follow the key (at least 1). They compare by
   * UTF-16 code unit (`compareKeys`), so the projection's SQL must order its
   * tie-break columns bytewise, with `COLLATE "C"`, or pages skip or repeat
   * rows at a boundary. Object ids and coin types are ASCII, where the two
   * orders agree.
   */
  tie: number;
}>;

export type CursorPosition = Readonly<{ key: readonly (string | number)[]; tie: readonly string[] }>;

export const MAX_CURSOR_LENGTH = 512;
const VERSION = 1;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const tokenSchema = z.string().min(1).max(MAX_CURSOR_LENGTH).regex(/^[A-Za-z0-9_-]+$/);
const decimalPartSchema = z.string().regex(DECIMAL);
const integerPartSchema = z.number().int();
const tiePartSchema = z.string().min(1).max(200);
const cursorEnvelopeSchema = z.strictObject({
  v: z.literal(VERSION), s: z.unknown().optional(), k: z.unknown().optional(), t: z.unknown().optional(),
});

/** UTF-8 `text` as unpadded base64url, with web APIs only: browsers read page tokens too. */
function toBase64Url(text: string): string {
  const binary = Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The UTF-8 text of an unpadded base64url token; throws on a token that is not UTF-8. */
function fromBase64Url(token: string): string {
  const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function checkPosition(shape: CursorShape, key: readonly unknown[], tie: readonly unknown[]): CursorPosition {
  if (shape.tie < 1) throw new CursorError("a cursor needs a tie-break");
  if (!z.array(z.unknown()).length(shape.key.length).safeParse(key).success) throw new CursorError("the cursor key has the wrong shape");
  key.forEach((part, index) => {
    const valid =
      shape.key[index] === "decimal"
        ? decimalPartSchema.safeParse(part).success
        : integerPartSchema.safeParse(part).success;
    if (!valid) throw new CursorError(`cursor key part ${index} is not a ${shape.key[index]}`);
  });
  if (!z.array(z.unknown()).length(shape.tie).safeParse(tie).success) throw new CursorError("the cursor tie-break has the wrong shape");
  if (!z.array(tiePartSchema).safeParse(tie).success) {
    throw new CursorError("a cursor tie-break is a non-empty string");
  }
  return { key: key as (string | number)[], tie: tie as string[] };
}

/** An opaque token for the position after which the next page starts. */
export function encodeCursor(shape: CursorShape, key: readonly (string | number)[], tie: readonly string[]): string {
  const position = checkPosition(shape, key, tie);
  const token = toBase64Url(JSON.stringify({ v: VERSION, s: shape.scope, k: position.key, t: position.tie }));
  if (token.length > MAX_CURSOR_LENGTH) throw new CursorError("the cursor is too long");
  return token;
}

/** The position a token holds, or CursorError when it is not a token of `shape`. */
export function decodeCursor(token: string, shape: CursorShape): CursorPosition {
  if (!tokenSchema.safeParse(token).success) {
    throw new CursorError("the cursor is not a page token");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64Url(token));
  } catch {
    throw new CursorError("the cursor is not a page token");
  }
  const parsed = cursorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) throw new CursorError("the cursor is not a page token");
  const { s, k, t } = parsed.data;
  if (s !== shape.scope) throw new CursorError("the cursor belongs to another list or order");
  return checkPosition(shape, k as unknown[], t as unknown[]);
}

function comparePart(kind: KeyPart, left: string | number, right: string | number): number {
  if (kind === "decimal") {
    const [a, b] = [BigInt(left), BigInt(right)];
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return Math.sign(Number(left) - Number(right));
}

/** Ascending order of two positions: the key part by part, then the tie-break. Direction is the projection's. */
export function compareKeys(shape: CursorShape, left: CursorPosition, right: CursorPosition): number {
  for (let index = 0; index < shape.key.length; index += 1) {
    const order = comparePart(shape.key[index], left.key[index], right.key[index]);
    if (order !== 0) return order;
  }
  for (let index = 0; index < shape.tie; index += 1) {
    if (left.tie[index] !== right.tie[index]) return left.tie[index] < right.tie[index] ? -1 : 1;
  }
  return 0;
}

/**
 * The page size for a `limit` query value: `bounds.default` when absent, at
 * least 1, and `bounds.max` for anything larger, never an error for size; only
 * digits are a limit.
 */
export function pageLimit(raw: string | null, bounds: Readonly<{ default: number; max: number }>): number {
  if (!(Number.isSafeInteger(bounds.default) && Number.isSafeInteger(bounds.max) && 1 <= bounds.default && bounds.default <= bounds.max)) {
    throw new RangeError("page bounds need 1 <= default <= max");
  }
  if (raw === null) return bounds.default;
  if (!z.string().regex(/^[0-9]+$/).safeParse(raw).success) throw new CursorError("limit must be a whole number");
  const limit = Number(raw);
  return Math.min(Math.max(limit, 1), bounds.max);
}

/**
 * A chain event's position as blast-infra names it,
 * `<checkpoint>:<tx_slot>:<event_slot>:<part>`: the cursor of a market frame
 * or trade, an activity id, a rewards position.
 */
export const EVENT_CURSOR =
  /^(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19})$/;

/** The chain order of two event cursors: negative, zero or positive. */
export function compareEventCursors(left: string, right: string): number {
  const a = left.split(":").map(BigInt);
  const b = right.split(":").map(BigInt);
  for (let index = 0; index < 4; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}
