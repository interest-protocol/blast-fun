import { z } from "zod";
import { socialAsOfSchema } from "@blast/core/modules/social/contracts/items.ts";
import type { SocialPresalePerson } from "@blast/core/modules/social/contracts/presales.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * Search (canonical UI §12; UI-12): presales by name or symbol and people by
 * callsign or display name.
 *
 * `GET /api/social/search?q=<text>`: public (`auth: "none"`, bucket
 * `social_read_search`, read on the replica, `public, s-maxage=10,
 * stale-while-revalidate=20` on a 200; errors `no-store`). The answer never
 * depends on who asks, so the CDN can share it:
 *
 * - `q` is optional and read once; it is trimmed, inner whitespace collapsed
 *   and lowercased (`normalizeSearchQuery`), and may hold at most
 *   `SEARCH_QUERY_MAX` characters (`400 invalid_parameter`, `parameter: q`).
 *   A leading `@` (a callsign) or `$` (a symbol) is dropped.
 * - With a term: up to `SEARCH_PRESALE_LIMIT` presales whose name or symbol
 *   contains it (`chain_read_v1.presales`: exact, then verified by Blast,
 *   then prefix, then live, upcoming, ended), and up to `SEARCH_PEOPLE_LIMIT` public accounts or
 *   members whose callsign or name contains it (exact callsign, callsign
 *   prefix, name prefix, then the shortest callsign).
 * - Without one: suggestions, the sales on now and next (live by closing
 *   time, then upcoming by opening time, then the latest ended) and the
 *   operator's default accounts in order.
 *
 * Private accounts are never answered. The viewer is not left out on the
 * server (that would make the answer personal and uncacheable): it answers
 * one person more than the sheet shows and the browser drops the viewer's
 * own callsign (`peopleForViewer`). `as_of` is the chain watermark; without
 * one the route answers `503 service_unavailable`.
 */
export const SOCIAL_SEARCH_ROUTE = "GET /api/social/search";
export const SOCIAL_SEARCH_PATH = "/api/social/search";

/** The longest term the route reads (a callsign is 20, a sale name rarely longer). */
export const SEARCH_QUERY_MAX = 64;
/** Rows shown per group (§12: "Up to 5 presales and 5 people"). */
export const SEARCH_GROUP_SIZE = 5;
export const SEARCH_PRESALE_LIMIT = SEARCH_GROUP_SIZE;
/** One more than shown, so the browser can drop the viewer and still show five. */
export const SEARCH_PEOPLE_LIMIT = SEARCH_GROUP_SIZE + 1;

export type SocialSearchPresale = Readonly<
  z.infer<typeof socialSearchResponseSchema>["presales"][number]
>;

export type SocialSearchResponse = Readonly<z.infer<typeof socialSearchResponseSchema>>;

/**
 * A raw `q` as the route reads it: trimmed, inner whitespace collapsed,
 * lowercased, a leading `@` or `$` dropped. Null when it is too long.
 */
export function normalizeSearchQuery(raw: string): string | null {
  const collapsed = raw.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  if (
    !z
      .string()
      .refine((value) => [...value].length <= SEARCH_QUERY_MAX)
      .safeParse(collapsed).success
  )
    return null;
  return collapsed.replace(/^[@$]+/u, "").trim();
}

/** The people the sheet shows a viewer: everyone but the viewer, at most five. */
export function peopleForViewer<Person extends Pick<SocialPresalePerson, "callsign">>(
  people: readonly Person[],
  viewerCallsign: string | null,
): Person[] {
  return people.filter((person) => person.callsign !== viewerCallsign).slice(0, SEARCH_GROUP_SIZE);
}

/** The route's path for a term: the normalized term only, so equal searches share one cached answer. */
export function socialSearchPath(query: string): string {
  const term = normalizeSearchQuery(query) ?? "";
  return term ? `${SOCIAL_SEARCH_PATH}?q=${encodeURIComponent(term)}` : SOCIAL_SEARCH_PATH;
}

// Scoped metadata retains this document's definitions and descriptions during generation.
export const searchSchemaMetadata = z.registry<z.core.JSONSchemaMeta>();

export const socialSearchResponseSchema = z
  .strictObject({
    query: z
      .string()
      .refine((value) => [...value].length <= 64)
      .register(searchSchemaMetadata, { maxLength: 64 }),
    presales: z
      .array(
        z.strictObject({
          presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
          name: z.string(),
          symbol: z.string(),
          icon_url: z.string(),
          phase: z.enum(["pending", "open", "closed", "funded", "trading", "cancelled"]),
          coin_type: z
            .string()
            .refine((value) => [...value].length >= 1)
            .register(searchSchemaMetadata, {
              minLength: 1,
              description: "Canonical sale coin type; optional for older cached responses.",
            })
            .optional(),
          verified_team: z
            .boolean()
            .register(searchSchemaMetadata, {
              description: "R3-23: Blast checked who is behind the sale (social_sale_trust); sent only when true.",
            })
            .optional(),
        }),
      )
      .max(5)
      .readonly(),
    people: z
      .array(
        z.strictObject({
          callsign: z.string().regex(/^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/),
          display_name: z.xor([z.null(), z.string()]),
          avatar_url: z.xor([z.null(), z.string()]),
          verified: z.boolean(),
        }),
      )
      .max(6)
      .readonly(),
    as_of: socialAsOfSchema,
  })
  .register(searchSchemaMetadata, {
    title: "Search answer",
    description:
      "GET /api/social/search 200: presales and people for a term (or suggestions), the same for every caller.",
  });

export const searchSchemaReferences = new Map<z.core.$ZodType, string>([
  [socialAsOfSchema, "https://blast-v2.invalid/social/contracts/as-of.schema.json"],
]);
