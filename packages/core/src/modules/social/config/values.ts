import { z } from "zod";

import {
  DECIMAL_PATTERN,
  MAX_BLOCKED_TERM_LENGTH,
  MAX_COUNT,
  MAX_MILESTONES,
  MAX_REACTIONS,
  REACTION_KEY_PATTERN,
  SOCIAL_CONFIG_DEFAULTS,
  SOCIAL_CONFIG_KEYS,
  SOCIAL_CONFIG_TYPES,
  type SocialConfig,
  type SocialConfigKey,
  type SocialConfigValue,
  type SocialConfigValueType,
} from "../contracts/config.ts";

/**
 * Validation of the social tuning values, shared by the operator's
 * `config set` (text typed on the command line) and the reader (JSON stored in
 * `social_config`). Every function returns `null` for a value it refuses.
 */

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const MAX_DAYS = 3650;
const configKeySchema = z.enum(SOCIAL_CONFIG_KEYS);
const integerSchema = z.number().int().max(Number.MAX_SAFE_INTEGER);
const decimalSchema = z.string().regex(DECIMAL_PATTERN).refine((value) => /[1-9]/.test(value))
  .transform((value) => value.includes(".") ? value.replace(/\.?0+$/, "") : value);
const integerListSchema = z.array(integerSchema.min(1)).min(1).max(MAX_MILESTONES)
  .refine((values) => new Set(values).size === values.length)
  .transform((values) => values.sort((left, right) => left - right));
const reactionListSchema = z.array(z.string().regex(REACTION_KEY_PATTERN)).min(1).max(MAX_REACTIONS)
  .refine((values) => new Set(values).size === values.length);
const listTextSchema = z.string().transform((text) => text.split(",").map((item) => item.trim()));
const nonnegativeIntegerText = z.string().regex(NON_NEGATIVE_INTEGER).transform(Number).pipe(integerSchema.nonnegative());
const positiveIntegerText = z.string().regex(POSITIVE_INTEGER).transform(Number).pipe(integerSchema.min(1));

const FROM_JSON = {
  duration_ms: integerSchema.nonnegative(),
  days: integerSchema.min(1).max(MAX_DAYS),
  decimal: decimalSchema,
  integer_list: integerListSchema,
  reaction_list: reactionListSchema,
  count: integerSchema.nonnegative().max(MAX_COUNT),
} satisfies Record<SocialConfigValueType, z.ZodType<SocialConfigValue>>;

const FROM_TEXT = {
  duration_ms: nonnegativeIntegerText,
  days: positiveIntegerText.pipe(integerSchema.max(MAX_DAYS)),
  decimal: decimalSchema,
  integer_list: listTextSchema.pipe(z.array(z.string().regex(POSITIVE_INTEGER)))
    .transform((values) => values.map(Number)).pipe(integerListSchema),
  reaction_list: listTextSchema.pipe(reactionListSchema),
  count: nonnegativeIntegerText.pipe(integerSchema.max(MAX_COUNT)),
} satisfies Record<SocialConfigValueType, z.ZodType<SocialConfigValue>>;

export function parseSocialConfigKey(text: string): SocialConfigKey | null {
  const parsed = configKeySchema.safeParse(text);
  return parsed.success ? parsed.data : null;
}

/**
 * A value as an operator types it: an integer (`1800000`), a decimal
 * (`2500` or `2500.5`) or a comma-separated list (`10,50,100` or
 * `fire,rocket`). Integer lists are stored ascending; reaction lists keep
 * their order.
 */
export function parseSocialConfigInput(key: SocialConfigKey, text: string): SocialConfigValue | null {
  const parsed = FROM_TEXT[SOCIAL_CONFIG_TYPES[key]].safeParse(text.trim());
  return parsed.success ? parsed.data : null;
}

/** A stored `social_config.value`, or `null` when it does not hold a valid value of the key's type. */
export function decodeSocialConfigValue(key: SocialConfigKey, value: unknown): SocialConfigValue | null {
  const parsed = FROM_JSON[SOCIAL_CONFIG_TYPES[key]].safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The typed configuration from `social_config` rows. A key with no row, or
 * with a stored value that is no longer valid, has its initial value; rows
 * for unknown keys are ignored.
 */
export function socialConfigFromRows(rows: readonly Readonly<{ key: string; value: unknown }>[]): SocialConfig {
  const config: Record<string, SocialConfigValue> = { ...SOCIAL_CONFIG_DEFAULTS };
  for (const row of rows) {
    const key = parseSocialConfigKey(row.key);
    if (!key) continue;
    const value = decodeSocialConfigValue(key, row.value);
    if (value !== null) config[key] = value;
  }
  return Object.freeze(config) as SocialConfig;
}

/**
 * A term as stored in `social_blocked_terms`: trimmed and lowercased, 1 to
 * 200 characters, with no control characters.
 */
const blockedTermSchema = z.string().trim().toLowerCase().min(1).max(MAX_BLOCKED_TERM_LENGTH)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));

export function normalizeBlockedTerm(text: string): string | null {
  const parsed = blockedTermSchema.safeParse(text);
  return parsed.success ? parsed.data : null;
}

/**
 * The first blocked term `text` contains anywhere, compared case-insensitively,
 * or `null`. Terms are stored lowercase.
 */
export function matchBlockedTerm(terms: readonly string[], text: string): string | null {
  const haystack = text.toLowerCase();
  return terms.find((term) => haystack.includes(term)) ?? null;
}
