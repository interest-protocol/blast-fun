import { z } from "zod";
import {
  POST_KINDS,
  THESIS_STANCES,
  DISCLOSURE_FIELDS,
  parseInertText,
  parseEvidenceLinks,
  type PostKind,
  type PostInput,
  type DisclosureInput,
} from "@blast/core/modules/launchpad-social/post-contract.ts";
/**
 * The launchpad's coin-scoped social contract (spec §6.9): a post is one
 * author's thesis or creator update on one launch, with inert text, evidence
 * links and a disclosure (text, an optional wallet and its holder
 * verification). Records are immutable; a revision is a new record. Parsers
 * accept exact shapes only and never echo input in their errors. Limits come
 * from `limits.ts` (provisional configuration). Browser-safe: no server
 * imports.
 */

import { parseLaunchId } from "@blast/core/lib/launchpad/launch-id.ts";
import type { CursorShape } from "@blast/core/modules/launchpad-contract/cursor.ts";
import {
  canonicalSuiAddress,
  hasExactKeys,
} from "@blast/server/modules/launchpad-identity/contracts.ts";
import {
  SOCIAL_LIMITS,
  type SocialLimits,
} from "@blast/core/modules/launchpad-social/limits.ts";

/** A creator's thesis or update (the writer is the launch's creator), or anyone's thesis. */
/** A holder proof as the prover returns it; the observation is the snapshot's checkpoint and time. */
export type HolderProof =
  | Readonly<{ verification: "unavailable" | "not_requested" }>
  | Readonly<{
      verification: "verified_holder" | "not_holder";
      checkpoint: number;
      observedAtMs: number;
      coinType: string;
    }>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/**
 * Characters that are not inert in text: C0 and C1 controls other than tab and
 * newline, and the bidirectional embeddings, overrides and isolates that can
 * reorder what a reader sees.
 */
function oneOf<T extends string>(values: readonly T[], value: unknown, field: string): T {
  const parsed = z.enum(values).safeParse(value);
  if (!parsed.success) throw new TypeError(`Unknown ${field}.`);
  return parsed.data;
}

/**
 * Plain text shown as text, never markup: well-formed Unicode in NFC, line
 * breaks as `\n`, trimmed, 1 to `maximum` code points, without controls or
 * bidirectional overrides.
 */
export function parseRecordId(value: unknown): string {
  const parsed = z.string().regex(UUID).safeParse(value);
  if (!parsed.success) throw new TypeError("Expected a record id.");
  return parsed.data;
}

export function parseDisclosure(value: unknown, limits: SocialLimits = SOCIAL_LIMITS): DisclosureInput {
  if (!hasExactKeys(value, DISCLOSURE_FIELDS)) throw new TypeError("A disclosure has exactly its fields.");
  return {
    text: value.text === null ? null : parseInertText(value.text, limits.disclosureCodePoints),
    walletAddress: value.walletAddress === null ? null : canonicalSuiAddress(value.walletAddress),
  };
}

/** A post write's `input`, exactly; any throw is a 400 at the mutation guard. */
export function parsePostInput(input: Record<string, unknown>, limits: SocialLimits = SOCIAL_LIMITS): PostInput {
  const launchId = typeof input.launchId === "string" ? parseLaunchId(input.launchId) : null;
  if (!launchId) throw new TypeError("Expected a canonical launch id.");
  const kind = oneOf(POST_KINDS, input.kind, "kind");
  const stance = input.stance === null && kind === "creator_update" ? null : oneOf(THESIS_STANCES, input.stance, "stance");
  return {
    launchId,
    kind,
    stance,
    body: parseInertText(input.body, limits.bodyCodePoints),
    evidenceLinks: parseEvidenceLinks(input.evidenceLinks, limits),
    disclosure: parseDisclosure(input.disclosure, limits),
    revisionOf: input.revisionOf === null ? null : parseRecordId(input.revisionOf),
  };
}

/**
 * Text in its search form: compatibility-normalized (NFKC), lower case, with
 * every run of whitespace a single space. Search tokens come from the same
 * form, so equal text always matches the same way.
 */
export function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * The materialized search text of a body: its search form, cut to the first
 * `searchTextCodePoints` code points. NFKC can expand a character up to 18
 * times (U+FDFA), so the cut, not the body limit, bounds the stored row.
 */
export function searchText(
  body: string,
  limits: SocialLimits = SOCIAL_LIMITS,
): string {
  return [...normalizeSearchText(body)]
    .slice(0, limits.searchTextCodePoints)
    .join("")
    .trim();
}

/** A post's public projections of its named identity sources (spec §6.9 `authorLabels`). */
export function authorLabels(
  post: Readonly<{
    kind: PostKind;
    disclosure: Readonly<{ walletAddress: string | null }>;
  }>,
): string[] {
  return [
    ...(post.kind === "community_thesis" ? [] : ["creator"]),
    ...(post.disclosure.walletAddress === null ? [] : ["wallet"]),
  ];
}

/** A launch's post list: newest first-post time, then thesis ID, both descending. */
export function thesesCursor(launchId: string): CursorShape {
  return { scope: `launch_theses:${launchId}`, key: ["decimal"], tie: 1 };
}

/** A search request that cannot be searched; its message never echoes the query. */
export class SocialQueryError extends Error {
  readonly code = "LAUNCHPAD_QUERY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SocialQueryError";
  }
}

/**
 * A text query as a PostgreSQL `simple` tsquery: up to `searchWords` words
 * (letters and digits of the normalized query, each cut to
 * `searchWordCodePoints`), every one required, each matching as a prefix.
 * Nothing else reaches the query, so no operator can be injected. No word, or
 * a query over `searchQueryLength` characters, is a SocialQueryError.
 */
export function searchQuery(raw: string, limits: SocialLimits = SOCIAL_LIMITS): string {
  if (!z.string().max(limits.searchQueryLength).safeParse(raw).success) throw new SocialQueryError("The search is too long.");
  const words = normalizeSearchText(raw).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) throw new SocialQueryError("The search has no words.");
  return words
    .slice(0, limits.searchWords)
    .map((word) => `${[...word].slice(0, limits.searchWordCodePoints).join("")}:*`)
    .join(" & ");
}
