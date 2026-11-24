/**
 * The social feed's tuning values (`social_config`, migration 0054). Each row
 * is one key whose `value` is JSON: a number for integers, a decimal string
 * for decimals, an array for lists. A key with no row has its initial value.
 * Operators change values with `npm run social:operator -- config set`.
 */

export const SOCIAL_CONFIG_KEYS = [
  "why_boost_ms",
  "big_boost_ms",
  "for_you_window_days",
  "for_you_migrated_days",
  "big_commit_usd",
  "big_trade_usd",
  "participant_milestones",
  "holder_milestones",
  "reactions",
  "fastest_window_ms",
  "recap_trading_days",
  "trade_sponsor_daily_cap",
] as const;
export type SocialConfigKey = (typeof SOCIAL_CONFIG_KEYS)[number];

/** How a key's value is typed, stored and entered on the command line. */
export type SocialConfigValueType =
  | "duration_ms" // a non-negative integer number of milliseconds
  | "days" // a positive integer number of days
  | "decimal" // a positive decimal string, such as "1000" or "2500.5"
  | "integer_list" // distinct positive integers, stored ascending
  | "reaction_list" // 1 to 8 distinct lowercase reaction keys, in display order
  | "count"; // a non-negative integer up to 100,000

export const SOCIAL_CONFIG_TYPES: Readonly<Record<SocialConfigKey, SocialConfigValueType>> = Object.freeze({
  why_boost_ms: "duration_ms",
  big_boost_ms: "duration_ms",
  for_you_window_days: "days",
  for_you_migrated_days: "days",
  big_commit_usd: "decimal",
  big_trade_usd: "decimal",
  participant_milestones: "integer_list",
  holder_milestones: "integer_list",
  reactions: "reaction_list",
  fastest_window_ms: "duration_ms",
  recap_trading_days: "days",
  trade_sponsor_daily_cap: "count",
});

export type SocialConfig = Readonly<{
  why_boost_ms: number;
  big_boost_ms: number;
  for_you_window_days: number;
  for_you_migrated_days: number;
  /** A decimal string in USD. */
  big_commit_usd: string;
  /** A decimal string in USD. */
  big_trade_usd: string;
  participant_milestones: readonly number[];
  holder_milestones: readonly number[];
  /** The accepted and shown reaction keys. A removed key's stored rows stay but are neither accepted nor shown. */
  reactions: readonly string[];
  /** Home's "Fastest filling" (FEATURE-MAP §5.2): commits in this window before the chain clock, ÷ the target. */
  fastest_window_ms: number;
  /** "Today on Blast" (§16) shows trading presales that migrated within this many days. */
  recap_trading_days: number;
  /**
   * Trades Blast's gas pool sponsors per account per UTC day (R3-31, OA-25
   * Q12), counted per account for embedded wallets and wallet sessions
   * alike; 0 sponsors none. Past it the wallet may still trade and pays its
   * own fee.
   */
  trade_sponsor_daily_cap: number;
}>;

export type SocialConfigValue = SocialConfig[SocialConfigKey];

/** The initial values, used for every key that has no `social_config` row. */
export const SOCIAL_CONFIG_DEFAULTS: SocialConfig = Object.freeze({
  why_boost_ms: 1_800_000,
  big_boost_ms: 1_800_000,
  for_you_window_days: 30,
  for_you_migrated_days: 7,
  big_commit_usd: "1000",
  big_trade_usd: "1000",
  participant_milestones: Object.freeze([10, 50, 100, 250, 500, 1000, 2500, 5000, 10000]),
  holder_milestones: Object.freeze([100, 250, 500, 1000, 2500, 5000, 10000]),
  // OA-5 (owner, 2026-10-03): the one reaction is a rocket.
  reactions: Object.freeze(["rocket"]),
  // FEATURE-MAP §5.2: "the last 6 hours' commits ÷ target".
  fastest_window_ms: 21_600_000,
  recap_trading_days: 30,
  // OA-25 Q12: a cap per account per day; 20 sponsored trades is a busy trader's day.
  trade_sponsor_daily_cap: 20,
});

/** The `social_reactions.reaction` slug (migration 0054). */
export const REACTION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_REACTIONS = 8;
export const MAX_MILESTONES = 50;
/** The largest `count` value. */
export const MAX_COUNT = 100_000;
/** A decimal value: up to 12 integer and 6 fractional digits. */
export const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;

/** A blocked term as stored in `social_blocked_terms`: lowercase, 1 to 200 characters. */
export const MAX_BLOCKED_TERM_LENGTH = 200;
