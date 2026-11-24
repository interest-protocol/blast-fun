import { matchesSchema, contractObject, contractValue, listSchema, ContractViolation, parseCount } from "@blast/core/modules/launchpad-contract/decimal.ts";
import { z } from "zod";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { parseLegacyPublicError, type LegacyPublicError } from "@blast/core/lib/public-error-messages.ts";
/**
 * Grouped launchpad search as `GET /api/launchpad/search` serves it,
 * browser-safe. Every match is a canonical Blast launch (its curve in
 * blast-infra's `chain_read_v1.pools`, its coin in `chain_read_v1.coins`),
 * read through the chain views at query time; a social row never makes one.
 * Each match names why it matched; there is no score.
 */

import { LAUNCH_LIFECYCLES } from "@blast/core/modules/launchpad-contract/discovery-views.ts";
import { parseSection, type Section } from "@blast/core/modules/launchpad-contract/section.ts";
import { POST_KINDS, THESIS_STANCES, type PostKind, type ThesisStance } from "@blast/core/modules/launchpad-social/post-contract.ts";
import type { LaunchIdentity } from "@blast/core/modules/launchpad-social/launch-identity.ts";

/**
 * The groups, in display order: identifier groups first, so an exact launch
 * ID, pool ID, wallet or coin type leads every text match. Profiles have no
 * source yet and are always Unavailable; a linked-X group is added only once
 * an authoritative X mapping exists.
 */
export const SEARCH_GROUPS = ["onchain", "wallets", "coins", "theses", "profiles"] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

/** The groups read from the chain views as launches. */
export const LAUNCH_GROUPS = ["onchain", "wallets", "coins"] as const;
export type LaunchGroup = (typeof LAUNCH_GROUPS)[number];

/** The groups a page token can continue. */
export const PAGED_GROUPS = ["onchain", "wallets", "coins", "theses"] as const;
export type PagedGroup = (typeof PAGED_GROUPS)[number];

/**
 * Why a launch matched, by tier: an exact identifier (`launch_id`,
 * `pool_id`, `creator`, `coin_type`), then the ticker or name equal to the
 * query, then every query word starting a word of the ticker or name.
 */
export const LAUNCH_MATCHES = ["launch_id", "pool_id", "creator", "coin_type", "ticker", "name", "words"] as const;
export type LaunchMatchKind = (typeof LAUNCH_MATCHES)[number];

/** The exact identifier matches. */
export const EXACT_MATCHES: readonly LaunchMatchKind[] = ["launch_id", "pool_id", "creator", "coin_type"];

/** A canonical launch's identity from the chain views (launchpad-social `LaunchIdentity`). */
export type SearchLaunch = LaunchIdentity;

export type LaunchMatch = Readonly<{
  match: LaunchMatchKind;
  launch: SearchLaunch;
  /** The migration pool a `pool_id` match named; null otherwise. */
  pool: Readonly<{ venue: string; poolId: string }> | null;
}>;

export type LaunchGroupPage = Readonly<{
  items: readonly LaunchMatch[];
  /** The next page's token, or null on the last page. */
  nextCursor: string | null;
}>;

/** A thesis as search shows it: its text, kind, stance and labels; never its author identity or a wallet. */
export type ThesisSnippet = Readonly<{
  id: string;
  thesisId: string;
  kind: PostKind;
  stance: ThesisStance | null;
  body: string;
  /** `creator` (a creator kind) and `wallet` (the author disclosed a wallet). */
  authorLabels: readonly string[];
  postedAt: string;
  createdAt: string;
}>;

/** A public, current thesis whose text has every query word as a word prefix, with its canonical launch. */
export type ThesisMatch = Readonly<{ match: "words"; thesis: ThesisSnippet; launch: SearchLaunch }>;

export type ThesisGroupPage = Readonly<{ items: readonly ThesisMatch[]; nextCursor: string | null }>;

/** One group of a search: a section in its honest state (profiles: always Unavailable, `no-source`). */
export type SearchGroupResult =
  | Readonly<{ group: LaunchGroup; section: Section<LaunchGroupPage> }>
  | Readonly<{ group: "theses"; section: Section<ThesisGroupPage> }>
  | Readonly<{ group: "profiles"; section: Section<never> }>;

export type SearchResponse = Readonly<{ groups: readonly SearchGroupResult[]; error?: LegacyPublicError }>;

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AUTHOR_LABELS = ["creator", "wallet"];

function record(value: unknown, field: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  return contractObject(value, field, keys, optional);
}

function matching(value: unknown, pattern: RegExp, field: string): string {
  return contractValue(z.string().regex(pattern), value, field, "is malformed");
}

function oneOf<T extends string>(values: readonly T[], value: unknown, field: string): T {
  return contractValue(z.enum(values), value, field, "is unknown");
}

function textOrNull(value: unknown, field: string, max = 1_000): string | null {
  return contractValue(z.string().max(max).nullable(), value, field, "must be text or null");
}

function time(value: unknown, field: string): string {
  return contractValue(z.string().refine((text) => Number.isFinite(Date.parse(text))), value, field, "must be a time");
}

function list<T>(value: unknown, field: string, parse: (item: unknown, field: string) => T): T[] {
  return contractValue(listSchema, value, field, "must be a list").map((item, index) => parse(item, `${field}[${index}]`));
}

function parseLaunch(value: unknown, field: string): SearchLaunch {
  const launch = record(value, field, ["launchId", "coinType", "name", "symbol", "iconUrl", "lifecycle", "creator", "createdAtMs"]);
  return {
    launchId: matching(launch.launchId, SUI_OBJECT_ID_PATTERN, `${field}.launchId`),
    coinType: matching(launch.coinType, COIN_TYPE, `${field}.coinType`),
    name: textOrNull(launch.name, `${field}.name`),
    symbol: textOrNull(launch.symbol, `${field}.symbol`),
    iconUrl: textOrNull(launch.iconUrl, `${field}.iconUrl`, 2_048),
    lifecycle: oneOf(LAUNCH_LIFECYCLES, launch.lifecycle, `${field}.lifecycle`),
    creator: launch.creator === null ? null : matching(launch.creator, SUI_OBJECT_ID_PATTERN, `${field}.creator`),
    createdAtMs: parseCount(launch.createdAtMs, `${field}.createdAtMs`),
  };
}

function parseLaunchMatch(value: unknown, field: string): LaunchMatch {
  const item = record(value, field, ["match", "launch", "pool"]);
  let pool: LaunchMatch["pool"] = null;
  if (item.pool !== null) {
    const raw = record(item.pool, `${field}.pool`, ["venue", "poolId"]);
    pool = {
      venue: matching(raw.venue, /^[a-z][a-z0-9_]{0,31}$/, `${field}.pool.venue`),
      poolId: matching(raw.poolId, SUI_OBJECT_ID_PATTERN, `${field}.pool.poolId`),
    };
  }
  return { match: oneOf(LAUNCH_MATCHES, item.match, `${field}.match`), launch: parseLaunch(item.launch, `${field}.launch`), pool };
}

function parseThesisMatch(value: unknown, field: string): ThesisMatch {
  const item = record(value, field, ["match", "thesis", "launch"]);
  const thesis = record(item.thesis, `${field}.thesis`, ["id", "thesisId", "kind", "stance", "body", "authorLabels", "postedAt", "createdAt"]);
  if (!matchesSchema(z.string().min(1).max(10_000), thesis.body)) {
    throw new ContractViolation(`${field}.thesis.body`, "must be text");
  }
  return {
    match: oneOf(["words"] as const, item.match, `${field}.match`),
    thesis: {
      id: matching(thesis.id, RECORD_ID, `${field}.thesis.id`),
      thesisId: matching(thesis.thesisId, RECORD_ID, `${field}.thesis.thesisId`),
      kind: oneOf(POST_KINDS, thesis.kind, `${field}.thesis.kind`),
      stance: thesis.stance === null ? null : oneOf(THESIS_STANCES, thesis.stance, `${field}.thesis.stance`),
      body: thesis.body,
      authorLabels: list(thesis.authorLabels, `${field}.thesis.authorLabels`, (label, at) => oneOf(AUTHOR_LABELS, label, at)),
      postedAt: time(thesis.postedAt, `${field}.thesis.postedAt`),
      createdAt: time(thesis.createdAt, `${field}.thesis.createdAt`),
    },
    launch: parseLaunch(item.launch, `${field}.launch`),
  };
}

function pageParser<T>(parseItem: (item: unknown, field: string) => T) {
  return (value: unknown) => {
    const page = record(value, "data", ["items", "nextCursor"]);
    if (page.nextCursor !== null && (!matchesSchema(z.string().min(1).max(512), page.nextCursor))) {
      throw new ContractViolation("data.nextCursor", "must be a page token or null");
    }
    return { items: list(page.items, "data.items", parseItem), nextCursor: page.nextCursor as string | null };
  };
}

const PARSERS: Readonly<Record<SearchGroup, (value: unknown) => unknown>> = {
  onchain: pageParser(parseLaunchMatch),
  wallets: pageParser(parseLaunchMatch),
  coins: pageParser(parseLaunchMatch),
  theses: pageParser(parseThesisMatch),
  profiles: () => {
    throw new ContractViolation("profiles", "has no data");
  },
};

/**
 * A served search, strictly. Each group parses on its own: one that breaks
 * the contract is Unavailable (`contract-violation`) without touching the
 * others, and a group this client does not know is not shown. A body that
 * is not a search at all throws ContractViolation.
 */
export function parseSearchResponse(value: unknown): SearchResponse {
  const body = record(value, "body", ["groups", "error"], ["error"]);
  const error = body.error === undefined ? undefined : parseLegacyPublicError(body.error);
  if (error === null) throw new ContractViolation("body.error", "must be a known public error");
  if (!matchesSchema(z.array(z.unknown()), body.groups)) throw new ContractViolation("body.groups", "must be a list");
  const groups: SearchGroupResult[] = [];
  for (const [index, raw] of body.groups.entries()) {
    const name = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).group : undefined;
    if (!SEARCH_GROUPS.includes(name as SearchGroup)) continue;
    const group = name as SearchGroup;
    try {
      const entry = record(raw, `groups[${index}]`, ["group", "section"]);
      groups.push({ group, section: parseSection(entry.section, PARSERS[group]) } as SearchGroupResult);
    } catch (error) {
      if (!(error instanceof ContractViolation)) throw error;
      groups.push({ group, section: { state: "unavailable", reason: "contract-violation" } } as SearchGroupResult);
    }
  }
  return { groups, ...(error ? { error } : {}) };
}
