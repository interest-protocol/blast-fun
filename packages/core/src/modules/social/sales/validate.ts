import { z } from "zod";
import {
  SALE_LINK_MAX,
  SALE_METADATA_FIELDS,
  SALE_TAGLINE_MAX,
  type SaleLinkField,
  type SaleMetadataField,
} from "@blast/core/modules/social/contracts/sales.ts";
import { validateWhy, whyLength } from "@blast/core/modules/social/whys/validate.ts";

/**
 * A sale's public details as they are stored (R3-24; OA-25 Q7): the rules
 * the creator's route, Create's draft and publish, and the browser's sheet
 * and form all share. Shared Zod validation, so it runs on the server and
 * in the client.
 *
 * - The tagline is the why-validator's text (`validateWhy`: NFC, trimmed,
 *   one line, no link) with its own length, 120 code points. Blank clears.
 *   Blocked terms live in the database (`findBlockedTerm`), so a server path
 *   checks them after this.
 * - A link is `http`/`https` with no userinfo and no port, on a DNS name with
 *   an alphabetic top-level label (no IP address, no `localhost`), stored as
 *   `https://<host>[/<path>][?<query>]`: the scheme upgraded, the host
 *   lowercased (and punycoded), the fragment dropped. A bare host
 *   (`meridian.finance`) is read as `https://meridian.finance`, as the gate
 *   reads it.
 * - X and Telegram are bare handles. A pasted profile URL
 *   (`https://x.com/@meridianfx`, `t.me/meridianfx`) or an `@` prefix is
 *   reduced to the handle, as the gate does on input.
 */

export type SaleTextRefusal = "tagline_too_long" | "tagline_invalid" | "tagline_has_link";
export type SaleFieldRefusal =
  | Readonly<{ code: SaleTextRefusal; field: "tagline" }>
  | Readonly<{ code: "invalid_link"; field: SaleLinkField }>
  | Readonly<{ code: "invalid_x_handle"; field: "x_handle" }>
  | Readonly<{ code: "invalid_telegram"; field: "telegram" }>;

export type Normalized = Readonly<{ ok: true; value: string | null }> | Readonly<{ ok: false }>;

const OK_NULL: Normalized = Object.freeze({ ok: true, value: null });
const BAD: Normalized = Object.freeze({ ok: false });

/** The tagline as stored (null when blank), or why it is refused. */
export function normalizeSaleTagline(text: string, maxLength = SALE_TAGLINE_MAX): Readonly<{ ok: true; value: string | null }> | Readonly<{ ok: false; code: SaleTextRefusal }> {
  const checked = validateWhy(text);
  if (!checked.ok) {
    if (checked.code === "why_empty") return OK_NULL as Readonly<{ ok: true; value: null }>;
    if (checked.code === "why_invalid") return { ok: false, code: "tagline_invalid" };
    if (checked.code === "why_too_long") return { ok: false, code: "tagline_too_long" };
    return { ok: false, code: "tagline_has_link" };
  }
  if (whyLength(checked.text) > maxLength) return { ok: false, code: "tagline_too_long" };
  return { ok: true, value: checked.text };
}

/** The tagline's length as the counter shows it (code points after NFC). */
export function saleTaglineLength(text: string): number {
  return whyLength(text.normalize("NFC").trim());
}

/** A DNS name whose last label starts with a letter: no IP literal, no single-label host. */
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A website, docs or audit link as stored (null when blank), or not ok. */
export function normalizeSaleLink(input: string): Normalized {
  const text = input.normalize("NFC").trim();
  if (!text) return OK_NULL;
  if (!z.string().max(SALE_LINK_MAX * 2).refine((value) => !/[\s\u0000-\u001f\u007f]/.test(value)).safeParse(text).success) return BAD;
  let url: URL;
  try {
    url = new URL(SCHEME.test(text) ? text : `https://${text}`);
  } catch {
    return BAD;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return BAD;
  if (url.username || url.password || url.port !== "") return BAD;
  // A typed port the URL parser dropped as the scheme's default is still a port.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*:\d*(?:[/?#]|$)/i.test(SCHEME.test(text) ? text : `https://${text}`)) return BAD;
  const host = url.hostname.toLowerCase();
  if (!z.string().regex(HOST).safeParse(host).success) return BAD;
  const path = url.pathname === "/" && !url.search ? "" : url.pathname;
  const value = `https://${host}${path}${url.search}`;
  return value.length <= SALE_LINK_MAX ? { ok: true, value } : BAD;
}

const X_URL = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([^/?#\s]*)(?:[/?#].*)?$/i;
const TELEGRAM_URL = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/@?([^/?#\s]*)(?:[/?#].*)?$/i;

/** What the gate keeps of a pasted X profile URL or `@handle`: the bare handle, unvalidated. */
export function bareXHandle(input: string): string {
  const text = input.trim();
  return (X_URL.exec(text)?.[1] ?? text).replace(/^@/, "");
}

/** What the gate keeps of a pasted Telegram link or `@name`: the bare name, unvalidated. */
export function bareTelegram(input: string): string {
  const text = input.trim();
  return (TELEGRAM_URL.exec(text)?.[1] ?? text).replace(/^@/, "");
}

/** An X handle as stored (null when blank), or not ok: 1 to 15 of `[A-Za-z0-9_]`. */
export function normalizeXHandle(input: string): Normalized {
  const handle = bareXHandle(input);
  if (!handle) return OK_NULL;
  return z.string().regex(/^[A-Za-z0-9_]{1,15}$/).safeParse(handle).success ? { ok: true, value: handle } : BAD;
}

/** A Telegram name as stored (null when blank), or not ok: 5 to 32 of `[A-Za-z0-9_]`. */
export function normalizeTelegram(input: string): Normalized {
  const name = bareTelegram(input);
  if (!name) return OK_NULL;
  return z.string().regex(/^[A-Za-z0-9_]{5,32}$/).safeParse(name).success ? { ok: true, value: name } : BAD;
}

export type SaleMetadataValues = Readonly<Partial<Record<SaleMetadataField, string | null>>>;

/**
 * The fields of a request as stored, or the first refusal in field order
 * (tagline, site, X, Telegram, docs, audit). Each value is a string or null
 * (null and a blank string both clear); `invalid` is any other value, which
 * the route answers as `invalid_request`.
 */
type SaleFieldResult = { ok: true; value: string | null } | { ok: false; refusal: SaleFieldRefusal } | { ok: false; invalid: true };

function normalizeSaleField(field: SaleMetadataField, raw: unknown): SaleFieldResult {
  const parsed = z.string().nullable().safeParse(raw);
  if (!parsed.success) return { ok: false, invalid: true };
  const text = parsed.data ?? "";
  if (field === "tagline") {
    const tagline = normalizeSaleTagline(text);
    if (!tagline.ok) return { ok: false, refusal: { code: tagline.code, field } };
    return { ok: true, value: tagline.value };
  }
  const normalized = field === "x_handle" ? normalizeXHandle(text) : field === "telegram" ? normalizeTelegram(text) : normalizeSaleLink(text);
  if (!normalized.ok) {
    const refusal: SaleFieldRefusal = field === "x_handle"
      ? { code: "invalid_x_handle", field }
      : field === "telegram"
        ? { code: "invalid_telegram", field }
        : { code: "invalid_link", field };
    return { ok: false, refusal };
  }
  return normalized;
}

export function normalizeSaleMetadata(
  body: Readonly<Record<string, unknown>>,
): Readonly<{ ok: true; values: SaleMetadataValues }> | Readonly<{ ok: false; refusal: SaleFieldRefusal }> | Readonly<{ ok: false; invalid: true }> {
  const values: Partial<Record<SaleMetadataField, string | null>> = {};
  for (const field of SALE_METADATA_FIELDS) {
    if (!Object.hasOwn(body, field)) continue;
    const normalized = normalizeSaleField(field, body[field]);
    if (!normalized.ok) return normalized;
    values[field] = normalized.value;
  }
  return { ok: true, values };
}

/** A stored link as the page shows it: no scheme, no `www.`, no trailing slash (`meridian.finance/docs`). */
export function saleLinkLabel(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
}
