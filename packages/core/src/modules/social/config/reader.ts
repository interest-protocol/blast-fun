import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import type { SocialConfig } from "../contracts/config.ts";
import { matchBlockedTerm, socialConfigFromRows } from "./values.ts";

/**
 * How long a process keeps the tuning values and blocked terms it read. A
 * value is loaded at most `SOCIAL_CONFIG_CACHE_MS` after the read that
 * produced the cached one began, so an operator's change reaches every social
 * route and the worker within 30 s plus one query, inside the 60 s promise.
 */
export const SOCIAL_CONFIG_CACHE_MS = 30_000;

export type CacheOptions = Readonly<{ ttlMs?: number; now?: () => number }>;

/**
 * A loader whose answer is kept for `ttlMs` from the moment its load began.
 * Callers that arrive during a load share it. A failed load is not kept: the
 * next call loads again, and the error reaches the callers that waited for it.
 */
export function cachedLoader<Value>(load: () => Promise<Value>, options: CacheOptions = {}): () => Promise<Value> {
  const ttlMs = options.ttlMs ?? SOCIAL_CONFIG_CACHE_MS;
  const now = options.now ?? Date.now;
  let cached: { value: Value; expiresAt: number } | null = null;
  let loading: Promise<Value> | null = null;
  return () => {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.value);
    if (loading) return loading;
    const startedAt = now();
    loading = load().then(
      (value) => {
        cached = { value, expiresAt: startedAt + ttlMs };
        loading = null;
        return value;
      },
      (error: unknown) => {
        loading = null;
        throw error;
      },
    );
    return loading;
  };
}

/** Every `social_config` row, typed, with the initial value for each key that has none. */
export async function loadSocialConfig(db: ReadableDatabase): Promise<SocialConfig> {
  const { rows } = await db.read<{ key: string; value: unknown }>("SELECT key, value FROM social_config");
  return socialConfigFromRows(rows);
}

/** Every blocked term, lowercase. */
export async function loadBlockedTerms(db: ReadableDatabase): Promise<readonly string[]> {
  const { rows } = await db.read<{ term: string }>("SELECT term FROM social_blocked_terms ORDER BY term");
  return Object.freeze(rows.map((row) => row.term));
}

export type SocialConfigReader = Readonly<{
  getSocialConfig(): Promise<SocialConfig>;
  findBlockedTerm(text: string): Promise<string | null>;
}>;

/** The cached readers over one database; `getSocialConfig` and `findBlockedTerm` are this over the primary. */
export function createSocialConfigReader(db: ReadableDatabase, options: CacheOptions = {}): SocialConfigReader {
  const config = cachedLoader(() => loadSocialConfig(db), options);
  const terms = cachedLoader(() => loadBlockedTerms(db), options);
  return Object.freeze({
    getSocialConfig: config,
    findBlockedTerm: async (text: string) => matchBlockedTerm(await terms(), text),
  });
}

function processReader(): SocialConfigReader {
  return processSingleton("social.config-reader", () =>
    createSocialConfigReader(autocommitReader(databaseFor("social"), "social", { label: "social.config" })));
}

/** The process's tuning values from the primary, cached 30 s; initial values for keys with no row. */
export function getSocialConfig(): Promise<SocialConfig> {
  return processReader().getSocialConfig();
}

/**
 * The blocked term `text` contains (case-insensitive, anywhere in the text),
 * or `null`; terms are read from the primary and cached 30 s. New "why" text,
 * callsigns and display names are checked with it; stored records are not.
 */
export function findBlockedTerm(text: string): Promise<string | null> {
  return processReader().findBlockedTerm(text);
}
