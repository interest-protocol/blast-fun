import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { matchesSchema, contractObject, contractValue, ContractViolation, parseCount } from "@blast/core/modules/launchpad-contract/decimal.ts";
import { z } from "zod";
import { parseLegacyPublicError, type LegacyPublicError } from "@blast/core/lib/public-error-messages.ts";
/**
 * The public thesis list as `GET /api/launchpad/theses` serves it and the
 * browser reads it: one launch's public posts as a section (available,
 * stale, empty or unavailable). The parser is strict and browser-safe: a
 * post that is not a public, inert, safe-linked record of the asked launch
 * makes the whole section Unavailable (`contract-violation`), so nothing it
 * carries is shown.
 */

import { NETWORK_NAME } from "@blast/core/modules/launchpad-contract/read.ts";
import { parseSection, type Section } from "@blast/core/modules/launchpad-contract/section.ts";
import { parseHttpsUrl } from "@blast/core/lib/https-url.ts";
import { POST_KINDS, THESIS_STANCES, UNSAFE_TEXT, VERIFICATIONS } from "@blast/core/modules/launchpad-social/post-contract.ts";
import type { PublicPost } from "@blast/core/modules/launchpad-social/post-contract.ts";

export type ThesisListPage = Readonly<{ items: readonly PublicPost[]; nextCursor: string | null }>;

export type ThesisListResponse = Readonly<{ launchId: string; theses: Section<ThesisListPage>; error?: LegacyPublicError }>;

const FINGERPRINT = /^[0-9a-f]{64}$/;
const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const AUTHOR_LABELS = ["creator", "wallet"] as const;
/** The database's ceilings; the write's own limits are lower. */
const TEXT_CEILING = 10_000;
const LINK_CEILING = 32;

function record(value: unknown, field: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  return contractObject(value, field, keys, optional);
}

function matching(value: unknown, pattern: RegExp, field: string): string {
  return contractValue(z.string().regex(pattern), value, field, "is malformed");
}

function oneOf<T extends string>(values: readonly T[], value: unknown, field: string): T {
  return contractValue(z.enum(values), value, field, "is unknown");
}

function inertText(value: unknown, field: string): string {
  if (!matchesSchema(z.string().min(1).max(TEXT_CEILING).refine((value) => !UNSAFE_TEXT.test(value)), value)) {
    throw new ContractViolation(field, "must be inert text");
  }
  return value;
}

function time(value: unknown, field: string): string {
  return contractValue(z.string().refine((text) => Number.isFinite(Date.parse(text))), value, field, "must be a time");
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

/** An https link without credentials, exactly in the normalized form the write stores. */
function safeLink(value: unknown, field: string): string {
  try {
    if (typeof value === "string" && parseHttpsUrl(value, 2_048) === value) return value;
  } catch {
    // Reported below.
  }
  throw new ContractViolation(field, "must be an https link without credentials");
}

function parsePost(value: unknown, field: string, launchId: string): PublicPost {
  const post = record(value, field, [
    "id", "thesisId", "revisionOf", "launchId", "kind", "stance", "authorIdentityId", "body", "evidenceLinks",
    "disclosure", "authorLabels", "moderationState", "provenance", "postedAt", "createdAt",
  ]);
  if (post.launchId !== launchId) throw new ContractViolation(`${field}.launchId`, "is another launch");
  if (post.moderationState !== "public") throw new ContractViolation(`${field}.moderationState`, "must be public");
  const kind = oneOf(POST_KINDS, post.kind, `${field}.kind`);
  const stance = post.stance === null && kind === "creator_update" ? null : oneOf(THESIS_STANCES, post.stance, `${field}.stance`);
  if (!matchesSchema(z.array(z.unknown()).max(LINK_CEILING), post.evidenceLinks)) {
    throw new ContractViolation(`${field}.evidenceLinks`, "must be a short list");
  }
  if (!matchesSchema(z.array(z.unknown()), post.authorLabels)) throw new ContractViolation(`${field}.authorLabels`, "must be a list");

  const disclosure = record(post.disclosure, `${field}.disclosure`, ["text", "walletAddress", "verification", "observedCheckpoint", "observedAt"]);
  const verification = oneOf(VERIFICATIONS, disclosure.verification, `${field}.disclosure.verification`);
  const walletAddress = nullable(disclosure.walletAddress, (item) => matching(item, SUI_OBJECT_ID_PATTERN, `${field}.disclosure.walletAddress`));
  const observedCheckpoint = nullable(disclosure.observedCheckpoint, (item) => matching(item, DECIMAL, `${field}.disclosure.observedCheckpoint`));
  const observedAt = nullable(disclosure.observedAt, (item) => time(item, `${field}.disclosure.observedAt`));
  const observed = verification === "verified_holder" || verification === "not_holder";
  if ((verification === "not_requested") !== (walletAddress === null) || observed !== (observedCheckpoint !== null) || observed !== (observedAt !== null)) {
    throw new ContractViolation(`${field}.disclosure`, "is inconsistent");
  }

  const provenance = record(post.provenance, `${field}.provenance`, ["network", "deployment", "checkpoint"]);
  return {
    id: matching(post.id, RECORD_ID, `${field}.id`),
    thesisId: matching(post.thesisId, RECORD_ID, `${field}.thesisId`),
    revisionOf: nullable(post.revisionOf, (item) => matching(item, RECORD_ID, `${field}.revisionOf`)),
    launchId,
    kind,
    stance,
    authorIdentityId: matching(post.authorIdentityId, RECORD_ID, `${field}.authorIdentityId`),
    body: inertText(post.body, `${field}.body`),
    evidenceLinks: post.evidenceLinks.map((link, index) => safeLink(link, `${field}.evidenceLinks[${index}]`)),
    disclosure: {
      text: nullable(disclosure.text, (item) => inertText(item, `${field}.disclosure.text`)),
      walletAddress,
      verification,
      observedCheckpoint,
      observedAt,
    },
    authorLabels: post.authorLabels.map((label, index) => oneOf(AUTHOR_LABELS, label, `${field}.authorLabels[${index}]`)),
    moderationState: "public",
    provenance: {
      network: matching(provenance.network, NETWORK_NAME, `${field}.provenance.network`),
      deployment: matching(provenance.deployment, FINGERPRINT, `${field}.provenance.deployment`),
      checkpoint: parseCount(provenance.checkpoint, `${field}.provenance.checkpoint`),
    },
    postedAt: time(post.postedAt, `${field}.postedAt`),
    createdAt: time(post.createdAt, `${field}.createdAt`),
  };
}

/** One served public post of `launchId`, strictly (a published post's answer); ContractViolation otherwise. */
export function parsePublicPost(value: unknown, launchId: string): PublicPost {
  return parsePost(value, "post", launchId);
}

/**
 * A served thesis list for `launchId`, strictly. An answer that is not a
 * list of that launch throws ContractViolation; a section whose data breaks
 * the contract is Unavailable (`contract-violation`).
 */
export function parseThesisListResponse(value: unknown, launchId: string): ThesisListResponse {
  const body = record(value, "body", ["launchId", "theses", "error"], ["error"]);
  const diagnostic = body.error === undefined ? undefined : parseLegacyPublicError(body.error);
  if (diagnostic === null) throw new ContractViolation("body.error", "must be a known public error");
  if (body.launchId !== launchId) throw new ContractViolation("body.launchId", "is another launch");
  try {
    const theses = parseSection(body.theses, (data) => {
      const page = record(data, "data", ["items", "nextCursor"]);
      if (!matchesSchema(z.array(z.unknown()), page.items)) throw new ContractViolation("data.items", "must be a list");
      if (page.nextCursor !== null && (!matchesSchema(z.string().min(1).max(512), page.nextCursor))) {
        throw new ContractViolation("data.nextCursor", "must be a page token or null");
      }
      return {
        items: page.items.map((item, index) => parsePost(item, `data.items[${index}]`, launchId)),
        nextCursor: page.nextCursor as string | null,
      };
    }, "theses");
    return { launchId, theses, ...(diagnostic ? { error: diagnostic } : {}) };
  } catch (error) {
    if (!(error instanceof ContractViolation)) throw error;
    return { launchId, theses: { state: "unavailable", reason: "contract-violation" }, ...(diagnostic ? { error: diagnostic } : {}) };
  }
}
