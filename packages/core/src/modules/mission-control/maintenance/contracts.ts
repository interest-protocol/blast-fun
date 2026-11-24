export const CLEANUP_TABLES = [
  "mission_control_rate_limit_windows",
  "mission_control_oauth_states",
  "mission_control_wallet_challenges",
  "mission_control_admission_failures",
  "mission_control_admission_attempts",
  "mission_control_member_sessions",
  "mission_control_callsign_attempt_limits",
  "mission_control_launchpad_coin_views",
  "mission_control_launchpad_outcomes",
  "mission_control_launchpad_outcome_commitments",
  "mission_control_launchpad_wallet_challenges",
  "presale_outcomes",
  "presale_outcome_commitments",
] as const;

export type CleanupTable = (typeof CLEANUP_TABLES)[number];

/** Rows deleted by one statement. Short statements keep row locks and WAL bursts small. */
export const CLEANUP_BATCH_SIZE = 1_000;
/** Wall-clock budget for one run; a run that hits it resumes on the next schedule. */
export const CLEANUP_BUDGET_MS = 20_000;
/**
 * How long a row is kept after it stops mattering. Covers clock skew between
 * instances and requests still in flight at the moment a row expires.
 */
export const CLEANUP_GRACE_MS = 60 * 60 * 1_000;
/** Expired or revoked member sessions stay this long for support and audit. */
export const MEMBER_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** Retain the original one-minute window for past callsign attempts. */
export const CALLSIGN_ATTEMPT_WINDOW_MS = 60 * 1_000;
/** The lifetime of a past admission attempt referenced by a wallet proof. */
export const ADMISSION_TTL_MS = 24 * 60 * 60 * 1_000;
/** The original lookback window before an admission failure stopped affecting challenges. */
export const ADMISSION_FAILURE_LOOKBACK_MS = 10 * 60 * 1_000;

export type CleanupTableResult = Readonly<{
  batches: number;
  /** Nothing eligible was left: the last batch deleted fewer rows than the batch size. */
  complete: boolean;
  deleted: number;
  durationMs: number;
  /** A SQLSTATE or error class name; never a message. */
  error?: string;
}>;

export type CleanupReport = Readonly<{
  complete: boolean;
  durationMs: number;
  ok: boolean;
  tables: Readonly<Record<CleanupTable, CleanupTableResult>>;
}>;

export type CleanupOptions = Readonly<{
  batchSize?: number;
  budgetMs?: number;
  clock?: () => Date;
}>;
