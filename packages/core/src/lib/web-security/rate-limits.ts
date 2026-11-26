import { z } from "zod";

import { WebSecurityError } from "./errors.ts";

export const RATE_POLICY_REGISTRY_VERSION = 30;

/** A server-owned capacity window refused; commercial quota was not consumed. */
export class OperationalRateLimited extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("Partner operational capacity is exhausted.");
    if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 60)
      throw new TypeError("Invalid operational retry interval.");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type RateBucket =
  | "telegram"
  | "share"
  | "code"
  | "wallet"
  | "recovery"
  | "wallet_ip"
  | "recovery_ip"
  | "callsign"
  | "completion"
  | "telemetry"
  | "oauth"
  | "launchpad_telemetry"
  | "launchpad_outcome"
  | "launchpad_outcome_commitment"
  | "launchpad_launch_asset"
  | "launchpad_social_post"
  | "launchpad_wallet_proof"
  | "launchpad_wallet_proof_issue"
  | WebRouteRateBucket
  | PresaleRateBucket
  | SocialRateBucket
  | LaunchpadMarketRateBucket;

/**
 * Buckets for routes outside the presale and social kits (WP3, bot
 * protection): the gate's re-issue endpoint, the team password, and reads
 * that had no limit. docs/security/bot-protection.md lists each one.
 */
export const WEB_ROUTE_RATE_BUCKETS = [
  "defillama_read",
  "defillama_public_global",
  "partner_read",
  "partner_read_global",
  "partner_auth_ip",
  "partner_auth_global",
  "admin_login_ip",
  "admin_login_global",
  "web_gate",
  "launchpad_search",
  "launchpad_discovery",
  "launchpad_wallet_launches",
  "launchpad_theses_read",
  "mission_control_card_image",
] as const;

export type WebRouteRateBucket = (typeof WEB_ROUTE_RATE_BUCKETS)[number];

/** The presale web routes' buckets (T-008); each route names its own. */
export const PRESALE_RATE_BUCKETS = [
  "presale_sponsor",
  "presale_sponsor_exec",
  "presale_allowlist",
  "presale_proof",
  "presale_allowlist_csv",
  "presale_bridge_quote",
  "presale_bridge_register",
  "presale_receipt",
  "presale_settings",
  "presale_reward_proof",
  "presale_outcome_commit",
  "presale_outcome",
  "presale_account_wallets",
  "presale_bridge_status",
  "presale_allowlist_read",
  "presale_sponsor_ip",
  "presale_sponsor_global",
  "presale_sponsor_exec_ip",
  "presale_sponsor_exec_global",
  "presale_sponsor_account_daily",
  "presale_sponsor_bad_signature",
  "presale_api_key_ip",
] as const;

export type PresaleRateBucket = (typeof PRESALE_RATE_BUCKETS)[number];

/** The social routes' buckets (social-feed T-002); the social route kit counts them. */
export const SOCIAL_RATE_BUCKETS = [
  "social_account_create",
  "social_follow",
  "social_reaction",
  "social_why",
  "social_report",
  "social_intent",
  "social_wallet_link",
  "social_account_update",
  "social_workspace_save",
  "social_read",
  "social_wallet_sign_in",
  "social_notification",
  "social_picture_upload",
  "social_pnl_card_publish",
  "social_create",
  "social_create_logo",
  "social_watchlist",
  "social_transfer",
  "social_trade_quote",
  "social_claim",
  "social_commit",
  "social_deposit",
  "social_bridge_withdraw",
  "social_read_search",
  "social_read_presales",
  "social_read_prices",
  "social_read_trade_coins",
  "social_read_portfolio",
  "social_read_quote",
  "social_trade_quote_anon",
  "social_me_read",
  "social_deposit_register",
  "social_auth_failure",
] as const;

export type SocialRateBucket = (typeof SOCIAL_RATE_BUCKETS)[number];

/**
 * The launchpad's same-origin market routes (`/api/launchpad/market/*`,
 * WP2 and the launchpad rewards reads): each relays one blast-infra `/v1`
 * read, so each counts in its own bucket, per client IP.
 */
export const LAUNCHPAD_MARKET_RATE_BUCKETS = [
  "launchpad_market_coin",
  "launchpad_market_holders",
  "launchpad_market_activity",
  "launchpad_market_pool",
  "launchpad_market_candles",
  "launchpad_market_trades",
  "launchpad_market_status",
  "launchpad_market_rewards",
  "launchpad_market_reward_rounds",
  "launchpad_market_wallet_launch_rewards",
  "launchpad_market_wallet_holder_rewards",
  "launchpad_market_wallet_launches",
  "launchpad_market_creator_claims",
  "launchpad_market_partners",
  "launchpad_market_partner",
  "launchpad_market_partner_launches",
  "launchpad_market_policy",
] as const;

export type LaunchpadMarketRateBucket = (typeof LAUNCHPAD_MARKET_RATE_BUCKETS)[number];

export type RateSubjectScope =
  | "ip"
  | "ip_address"
  | "attempt"
  | "admission_or_session"
  /** A signed-in Privy account, keyed `account:<did>`. */
  | "account"
  /** A signed-in Privy account (`account:<did>`), else an agent API key (`api_key:<id>`). */
  | "account_or_api_key"
  /** A verified partner key UUID, stable across IPs and policy changes. */
  | "api_key"
  /**
   * The client IP and the signed-in Privy account, each counted on its own
   * (`ip:<ip>` and `account:<did>`): the caller consumes once per part, with a
   * subject that holds only that part, and a request is refused when either
   * is full.
   */
  | "ip_and_account"
  /** Everyone at once (`global`): a platform-wide budget, such as sponsored gas per UTC day. */
  | "global";

export interface RateWindowPolicy {
  limit: number;
  windowSeconds: number;
}

export interface RatePolicy {
  bucket: RateBucket;
  version: number;
  subjectScope: RateSubjectScope;
  windows: readonly RateWindowPolicy[];
}

export interface RatePolicyRegistryOptions {
  oauth?: RateWindowPolicy;
  /** Sponsor reservations per UTC day, platform-wide (`PRESALE_SPONSOR_DAILY_CAP`). */
  presaleSponsorDailyCap?: number;
  /** Sponsored executions per UTC day, platform-wide (`PRESALE_SPONSOR_EXEC_DAILY_CAP`). */
  presaleSponsorExecDailyCap?: number;
}

/** Default platform-wide sponsor budgets per UTC day; the environment can change them. */
export const DEFAULT_PRESALE_SPONSOR_DAILY_CAP = 20_000;
export const DEFAULT_PRESALE_SPONSOR_EXEC_DAILY_CAP = 5_000;
const MAX_DAILY_CAP = 10_000_000;

function dailyCap(value: number | undefined, fallback: number): number {
  const cap = value ?? fallback;
  if (!z.number().int().min(1).max(MAX_DAILY_CAP).safeParse(cap).success) {
    throw new TypeError("Rate policy is outside its configured bounds.");
  }
  return cap;
}

/**
 * The registry options the environment sets: the sponsor routes' daily caps
 * (`PRESALE_SPONSOR_DAILY_CAP`, `PRESALE_SPONSOR_EXEC_DAILY_CAP`, whole
 * numbers from 1 to 10,000,000). An unset value keeps the default; a
 * malformed one throws, so the route answers `service_unavailable` rather
 * than run without a cap.
 */
export function ratePolicyOptionsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RatePolicyRegistryOptions {
  const read = (name: string): number | undefined => {
    const raw = environment[name]?.trim();
    if (!raw) return undefined;
    if (!z.string().regex(/^[1-9][0-9]{0,7}$/).safeParse(raw).success) throw new TypeError(`${name} must be a whole number from 1 to ${MAX_DAILY_CAP}.`);
    return Number(raw);
  };
  return {
    presaleSponsorDailyCap: read("PRESALE_SPONSOR_DAILY_CAP"),
    presaleSponsorExecDailyCap: read("PRESALE_SPONSOR_EXEC_DAILY_CAP"),
  };
}

function checkedWindow(
  value: RateWindowPolicy,
  bounds: { maxLimit: number; maxWindow: number },
): RateWindowPolicy {
  if (!z.object({
    limit: z.number().int().min(1).max(bounds.maxLimit),
    windowSeconds: z.number().int().min(1).max(bounds.maxWindow),
  }).safeParse(value).success) {
    throw new TypeError("Rate policy is outside its configured bounds.");
  }
  return Object.freeze({ ...value });
}

/** Wallet-signature attempts; the launchpad proof buckets reuse these values. */
const WALLET_WINDOWS: readonly RateWindowPolicy[] = Object.freeze([
  Object.freeze({ limit: 5, windowSeconds: 600 }),
]);

export function createRatePolicyRegistry(
  options: RatePolicyRegistryOptions = {},
): Readonly<Record<RateBucket, RatePolicy>> {
  const oauth = checkedWindow(
    options.oauth ?? { limit: 10, windowSeconds: 600 },
    { maxLimit: 100, maxWindow: 3_600 },
  );
  const sponsorDaily = dailyCap(options.presaleSponsorDailyCap, DEFAULT_PRESALE_SPONSOR_DAILY_CAP);
  const sponsorExecDaily = dailyCap(options.presaleSponsorExecDailyCap, DEFAULT_PRESALE_SPONSOR_EXEC_DAILY_CAP);
  return Object.freeze({
    telegram: Object.freeze({
      bucket: "telegram", version: 1, subjectScope: "admission_or_session",
      windows: Object.freeze([{ limit: 3, windowSeconds: 60 }, { limit: 10, windowSeconds: 3600 }]),
    }),
    share: Object.freeze({
      bucket: "share", version: 1, subjectScope: "admission_or_session",
      windows: Object.freeze([{ limit: 3, windowSeconds: 60 }, { limit: 10, windowSeconds: 3600 }]),
    }),
    code: Object.freeze({
      bucket: "code",
      version: 1,
      subjectScope: "ip",
      windows: Object.freeze([
        Object.freeze({ limit: 10, windowSeconds: 60 }),
        Object.freeze({ limit: 30, windowSeconds: 3_600 }),
      ]),
    }),
    wallet: Object.freeze({
      bucket: "wallet",
      version: 2,
      subjectScope: "ip_address",
      windows: WALLET_WINDOWS,
    }),
    recovery: Object.freeze({
      bucket: "recovery",
      version: 1,
      subjectScope: "ip_address",
      windows: Object.freeze([
        Object.freeze({ limit: 5, windowSeconds: 600 }),
      ]),
    }),
    // Review L3: `wallet` and `recovery` are keyed by the client IP and an
    // address the client chooses, so rotating addresses multiplied them. These
    // count the client IP alone, beside them: about a dozen wallet sign-ins
    // (an issue and a verify each) or crew restores per ten minutes per address.
    wallet_ip: Object.freeze({
      bucket: "wallet_ip",
      version: 1,
      subjectScope: "ip",
      windows: Object.freeze([Object.freeze({ limit: 30, windowSeconds: 600 })]),
    }),
    recovery_ip: Object.freeze({
      bucket: "recovery_ip",
      version: 1,
      subjectScope: "ip",
      windows: Object.freeze([Object.freeze({ limit: 20, windowSeconds: 600 })]),
    }),
    callsign: Object.freeze({
      bucket: "callsign",
      version: 1,
      subjectScope: "attempt",
      windows: Object.freeze([
        Object.freeze({ limit: 30, windowSeconds: 60 }),
      ]),
    }),
    completion: Object.freeze({
      bucket: "completion",
      version: 2,
      subjectScope: "attempt",
      windows: Object.freeze([
        Object.freeze({ limit: 5, windowSeconds: 60 }),
        Object.freeze({ limit: 30, windowSeconds: 600 }),
      ]),
    }),
    telemetry: Object.freeze({
      bucket: "telemetry",
      version: 1,
      subjectScope: "admission_or_session",
      windows: Object.freeze([
        Object.freeze({ limit: 12, windowSeconds: 60 }),
      ]),
    }),
    oauth: Object.freeze({
      bucket: "oauth",
      version: 1,
      subjectScope: "ip",
      windows: Object.freeze([oauth]),
    }),
    // Launchpad coin-view beacons (modules/launchpad-telemetry), per client
    // IP. Separate from Mission Control's session-scoped `telemetry` bucket.
    // Generous for a reader opening coins, tight enough that one client
    // cannot mint an unbounded denominator.
    launchpad_telemetry: Object.freeze({
      bucket: "launchpad_telemetry",
      version: 1,
      subjectScope: "ip",
      windows: Object.freeze([
        Object.freeze({ limit: 30, windowSeconds: 60 }),
        Object.freeze({ limit: 300, windowSeconds: 3_600 }),
      ]),
    }),
    // Verified-outcome reports (POST /api/launchpad/outcomes), per client IP,
    // counted apart from coin views. PROVISIONAL: reuses the
    // `launchpad_telemetry` values until the owner sets its own.
    launchpad_outcome: Object.freeze({
      bucket: "launchpad_outcome",
      version: 1,
      subjectScope: "ip",
      windows: Object.freeze([
        Object.freeze({ limit: 30, windowSeconds: 60 }),
        Object.freeze({ limit: 300, windowSeconds: 3_600 }),
      ]),
    }),
    // Verified-outcome digest commitments (POST
    // /api/launchpad/outcomes/commitments), per client IP, counted apart from
    // reports. PROVISIONAL: reuses the `launchpad_telemetry` values until the
    // owner sets its own.
    launchpad_outcome_commitment: Object.freeze({
      bucket: "launchpad_outcome_commitment",
      version: 1,
      subjectScope: "ip",
      windows: Object.freeze([
        Object.freeze({ limit: 30, windowSeconds: 60 }),
        Object.freeze({ limit: 300, windowSeconds: 3_600 }),
      ]),
    }),
    // Launch image uploads (modules/launch-assets), per client IP, for either
    // credential. PROVISIONAL: reuses the `wallet` values until the owner sets
    // final public limits with the other launchpad write routes.
    launchpad_launch_asset: Object.freeze({
      bucket: "launchpad_launch_asset",
      version: 1,
      subjectScope: "ip",
      windows: WALLET_WINDOWS,
    }),
    // Launchpad social posts (modules/launchpad-social), per client IP, for
    // either credential. PROVISIONAL: reuses the `wallet` values until the
    // owner sets final public limits with the other launchpad write routes.
    launchpad_social_post: Object.freeze({
      bucket: "launchpad_social_post",
      version: 1,
      subjectScope: "ip",
      windows: WALLET_WINDOWS,
    }),
    // Launchpad Wallet Proofs (modules/launchpad-identity), counted apart from
    // Mission Control's `wallet` bucket. PROVISIONAL: both reuse the `wallet`
    // values until the owner sets final public limits, a release gate before
    // launchpad write routes go public. Proof checks are keyed like `wallet`
    // (IP, address and operation); challenge issuance by client IP alone, so
    // rotating addresses cannot multiply it.
    launchpad_wallet_proof: Object.freeze({
      bucket: "launchpad_wallet_proof",
      version: 1,
      subjectScope: "ip_address",
      windows: WALLET_WINDOWS,
    }),
    launchpad_wallet_proof_issue: Object.freeze({
      bucket: "launchpad_wallet_proof_issue",
      version: 1,
      subjectScope: "ip",
      windows: WALLET_WINDOWS,
    }),
    ...WEB_ROUTE_RATE_POLICIES,
    ...PRESALE_RATE_POLICIES,
    presale_sponsor_global: presalePolicy("presale_sponsor_global", "global", sponsorDaily, 86_400),
    presale_sponsor_exec_global: presalePolicy("presale_sponsor_exec_global", "global", sponsorExecDaily, 86_400),
    ...SOCIAL_RATE_POLICIES,
    ...LAUNCHPAD_MARKET_RATE_POLICIES,
  });
}

function singleWindow<Bucket extends RateBucket>(
  bucket: Bucket,
  subjectScope: RateSubjectScope,
  windows: readonly RateWindowPolicy[],
): RatePolicy {
  return Object.freeze({
    bucket,
    version: 1,
    subjectScope,
    windows: Object.freeze(windows.map((window) => Object.freeze({ ...window }))),
  });
}

/**
 * Routes outside the kits (WP3). Reads are generous for a person (a page
 * makes a handful of calls, polls every few seconds at most) and tight where a
 * call is expensive. First-party buckets are per client IP (IPv6 per /64,
 * see client-address.ts); partner reads share a stable key UUID across IPs and policy changes.
 */
// Changing these contractual defaults also requires a migration updating the
// standard-tier defaults, existing standard rows and CHECK constraint in 0127.
export const PARTNER_STANDARD_LIMITS = Object.freeze({ requestsPerMinute: 300, requestsPerDay: 50_000 });

const WEB_ROUTE_RATE_POLICIES: Readonly<Record<WebRouteRateBucket, RatePolicy>> = Object.freeze({
  admin_login_ip: singleWindow("admin_login_ip", "ip", [{ limit: 5, windowSeconds: 60 }]),
  admin_login_global: singleWindow("admin_login_global", "global", [{ limit: 100, windowSeconds: 60 }]),
  partner_read_global: singleWindow("partner_read_global", "global", [{ limit: 600, windowSeconds: 60 }]),
  partner_auth_ip: singleWindow("partner_auth_ip", "ip", [{ limit: 600, windowSeconds: 60 }]),
  // Bounds primary registry work before a key or preflight origin is trusted.
  partner_auth_global: singleWindow("partner_auth_global", "global", [{ limit: 3_000, windowSeconds: 60 }]),
  partner_read: singleWindow("partner_read", "api_key", [
    { limit: PARTNER_STANDARD_LIMITS.requestsPerMinute, windowSeconds: 60 },
    { limit: PARTNER_STANDARD_LIMITS.requestsPerDay, windowSeconds: 86_400 },
  ]),
  // GET /api/gate re-issues an expired gate cookie: once per open tab every
  // two hours, so a few dozen per ten minutes covers many tabs behind one IP.
  web_gate: singleWindow("web_gate", "ip", [{ limit: 30, windowSeconds: 600 }]),
  // Launchpad search joins on the replica and is never cached.
  launchpad_search: singleWindow("launchpad_search", "ip", [{ limit: 60, windowSeconds: 60 }]),
  // Discovery reads blast-infra; a cursor or limit busts the CDN cache.
  launchpad_discovery: singleWindow("launchpad_discovery", "ip", [{ limit: 120, windowSeconds: 60 }]),
  defillama_read: singleWindow("defillama_read", "ip", [{ limit: 120, windowSeconds: 60 }]),
  defillama_public_global: singleWindow("defillama_public_global", "global", [{ limit: 300, windowSeconds: 60 }]),
  // A wallet's own launches as discovery rows: read on opening the portfolio's Launches and paging.
  launchpad_wallet_launches: singleWindow("launchpad_wallet_launches", "ip", [{ limit: 120, windowSeconds: 60 }]),
  launchpad_theses_read: singleWindow("launchpad_theses_read", "ip", [{ limit: 240, windowSeconds: 60 }]),
  // A published card's public image (`/card/{id}/image`, outside `/api`, so
  // no gate; review M3): a request the CDN did not answer reads the card and
  // may render. Unfurlers (X, Slack, Discord, Telegram) fetch from shared
  // addresses, so the budget is generous; non-canonical URLs are redirected
  // before they count.
  mission_control_card_image: singleWindow("mission_control_card_image", "ip", [{ limit: 300, windowSeconds: 60 }]),
});

function presalePolicy(
  bucket: PresaleRateBucket,
  subjectScope: RateSubjectScope,
  limit: number,
  windowSeconds: number,
): RatePolicy {
  return Object.freeze({
    bucket,
    version: 1,
    subjectScope,
    windows: Object.freeze([Object.freeze({ limit, windowSeconds })]),
  });
}

/**
 * The presale web routes' limits. Windows start on multiples of their own
 * length from the Unix epoch, which is midnight UTC, so the 86,400-second
 * window of `presale_sponsor_exec` is exactly one UTC day: its budget resets at
 * 00:00 UTC and a refusal's Retry-After runs to the next UTC midnight.
 */
const PRESALE_RATE_POLICIES: Readonly<Record<PresaleRateBucket, RatePolicy>> = Object.freeze({
  presale_sponsor: presalePolicy("presale_sponsor", "account", 30, 600),
  presale_sponsor_exec: presalePolicy("presale_sponsor_exec", "account", 100, 86_400),
  presale_allowlist: presalePolicy("presale_allowlist", "account_or_api_key", 20, 3_600),
  presale_proof: presalePolicy("presale_proof", "ip", 120, 60),
  presale_allowlist_csv: presalePolicy("presale_allowlist_csv", "api_key", 10, 60),
  presale_bridge_quote: presalePolicy("presale_bridge_quote", "ip", 60, 60),
  presale_bridge_register: presalePolicy("presale_bridge_register", "ip", 20, 600),
  presale_receipt: presalePolicy("presale_receipt", "ip", 60, 60),
  presale_settings: presalePolicy("presale_settings", "account", 30, 600),
  presale_reward_proof: presalePolicy("presale_reward_proof", "ip", 120, 60),
  presale_outcome_commit: presalePolicy("presale_outcome_commit", "ip", 60, 60),
  presale_outcome: presalePolicy("presale_outcome", "ip", 30, 60),
  presale_account_wallets: presalePolicy("presale_account_wallets", "account", 60, 600),
  // WP3. A transfer's status, polled while a bridge is in flight.
  presale_bridge_status: presalePolicy("presale_bridge_status", "ip", 120, 60),
  // An agent's or account's read of its own allowlist.
  presale_allowlist_read: presalePolicy("presale_allowlist_read", "account_or_api_key", 120, 60),
  // Sponsored gas, per client IP on top of per account: free Privy accounts
  // would otherwise multiply the account budget. Four accounts' worth of
  // reservations per ten minutes; executions an hour at a time.
  presale_sponsor_ip: presalePolicy("presale_sponsor_ip", "ip", 120, 600),
  presale_sponsor_exec_ip: presalePolicy("presale_sponsor_exec_ip", "ip", 60, 3_600),
  // One account's share of the platform's daily sponsor cap, counted with it
  // after the dry run (review H1). This includes trades and abandoned
  // reservations; one account cannot spend more than 1/200 of the default cap.
  presale_sponsor_account_daily: presalePolicy("presale_sponsor_account_daily", "account", 100, 86_400),
  // Wrong signatures on one reservation (`attemptId` = the reservation id,
  // review H2): two are tolerated; the third expires the reservation. The
  // window outlives a reservation (about 140 s).
  presale_sponsor_bad_signature: presalePolicy("presale_sponsor_bad_signature", "attempt", 2, 3_600),
  // Agent API key lookups per client IP (review M2), counted in memory before
  // the key is read from the primary: a forged key of the right shape passes
  // the API gate. Above an agent's allowlist reads (120 / min per key).
  presale_api_key_ip: presalePolicy("presale_api_key_ip", "ip", 300, 60),
  // The platform-wide daily caps are set in createRatePolicyRegistry (configurable).
  presale_sponsor_global: presalePolicy("presale_sponsor_global", "global", DEFAULT_PRESALE_SPONSOR_DAILY_CAP, 86_400),
  presale_sponsor_exec_global: presalePolicy("presale_sponsor_exec_global", "global", DEFAULT_PRESALE_SPONSOR_EXEC_DAILY_CAP, 86_400),
});

/**
 * The social routes' limits (social-feed T-002). Route-spec account buckets
 * count the verified sign-in before account resolution. Workspace saves use
 * the resolved stable Blast Account instead, sharing its budget across linked
 * sign-ins. `social_account_create` counts IP and sign-in apart (`ip_and_account`).
 */
const SOCIAL_RATE_POLICIES: Readonly<Record<SocialRateBucket, RatePolicy>> = Object.freeze({
  social_account_create: socialPolicy("social_account_create", "ip_and_account", 5, 3_600),
  social_follow: socialPolicy("social_follow", "account", 120, 60),
  social_reaction: socialPolicy("social_reaction", "account", 240, 60),
  social_why: socialPolicy("social_why", "account", 20, 3_600),
  social_report: socialPolicy("social_report", "account", 30, 3_600),
  social_intent: socialPolicy("social_intent", "account", 60, 60),
  social_wallet_link: socialPolicy("social_wallet_link", "account", 10, 3_600),
  social_workspace_save: socialPolicy("social_workspace_save", "account", 60, 60),
  social_account_update: socialPolicy("social_account_update", "account", 30, 600),
  social_read: socialPolicy("social_read", "ip", 600, 60),
  // Wallet sign-in (UI-08), before any account exists: per client IP. A
  // challenge and a proof each count; every proof may cost a fullnode call
  // (zkLogin), so the budget is a few full sign-ins per ten minutes. Sign-out
  // counts here too.
  social_wallet_sign_in: socialPolicy("social_wallet_sign_in", "ip", 20, 600),
  // Notifications (UI-13): reading a page and marking read, per account. A
  // row click marks one read, so the budget is a busy reader's clicks.
  social_notification: socialPolicy("social_notification", "account", 240, 60),
  // Profile picture uploads (UI-06): each decodes and re-encodes an image and
  // writes the public blob store, so a few per hour per account.
  social_picture_upload: socialPolicy("social_picture_upload", "account", 10, 3_600),
  social_pnl_card_publish: socialPolicy("social_pnl_card_publish", "account", 30, 3_600),
  // Create (UI-20): draft saves, deletes and publish plans, per account. The
  // page autosaves at most once a second while typing, so a busy minute
  // stays under it. Logo uploads decode an image each, so they have their own.
  social_create: socialPolicy("social_create", "account", 120, 60),
  social_create_logo: socialPolicy("social_create_logo", "account", 20, 600),
  // Watchlist stars (UI-12): adding and removing, per account. A star is a
  // tap like a follow, so the follow budget.
  social_watchlist: socialPolicy("social_watchlist", "account", 120, 60),
  // Coins (UI-14): recording and settling withdrawals, per account. One
  // withdrawal is two calls (record, then its digest) plus a few settle
  // retries; settling reads a fullnode, so a few dozen per ten minutes.
  social_transfer: socialPolicy("social_transfer", "account", 60, 600),
  // Trading (R3-30): a signed-in caller's quotes, per account, on top of the
  // quote route's per-IP `social_read`. Each one asks Cetus's aggregator and
  // dry-runs on a fullnode (a sale coin's twice, OA-29's reference run, still
  // one quote here); the swap box re-quotes as the amount changes and
  // every 20 s, so a busy minute of typing stays under it.
  social_trade_quote: socialPolicy("social_trade_quote", "account", 120, 60),
  // Claims (R3-63): recording and settling a presale claim, per account. One
  // claim is up to three calls (record, its digest or its failure) plus a few
  // settle retries; recording dry-runs on a fullnode, so the transfers' budget.
  social_claim: socialPolicy("social_claim", "account", 60, 600),
  // Commits: building a presale commit on the server for the Blast wallet to
  // sign, per account. One blast is one build (the sponsor and the intent
  // count in their own buckets); a build reads the deployment's node (the
  // sale's object, the wallet's balance and coins), so the claims' budget.
  social_commit: socialPolicy("social_commit", "account", 60, 600),
  // Deposits from another chain (OA-25): recording an attempt (it reads
  // Circle's fees through the bridge's cached client), its source hash, and
  // the in-flight reads that follow it until the USDC lands (one every 15 s
  // or so per open deposit), per account.
  social_deposit: socialPolicy("social_deposit", "account", 120, 600),
  // Withdraw to another chain: building a CCTP burn for the Blast wallet to
  // sign, per account. Each build asks Circle (cached), reads the wallet on
  // a fullnode, dry-runs the burn and may reserve sponsored gas; a burn moves
  // money off Sui for good, so half the transfers' budget. Settling counts in
  // `social_transfer`.
  social_bridge_withdraw: socialPolicy("social_bridge_withdraw", "account", 30, 600),
  // WP3: public reads split by family, so one cheap route cannot spend
  // another's budget and the expensive ones are tighter. `social_read` keeps
  // the feed, items, profiles, Happening, activity and signed-in reads.
  // Search runs a trigram match on the replica per keystroke (debounced).
  social_read_search: socialPolicy("social_read_search", "ip", 60, 60),
  // The presale list and pages (blast-infra reads); panels and docks poll them.
  social_read_presales: socialPolicy("social_read_presales", "ip", 300, 60),
  social_read_prices: socialPolicy("social_read_prices", "ip", 300, 60),
  social_read_trade_coins: socialPolicy("social_read_trade_coins", "ip", 120, 60),
  // A public portfolio values holdings on a fullnode.
  social_read_portfolio: socialPolicy("social_read_portfolio", "ip", 60, 60),
  // Every trade quote per IP (Cetus aggregator and a fullnode dry-run each);
  // a signed-out quote also counts in `social_trade_quote_anon`, a signed-in
  // one in `social_trade_quote` (per account).
  social_read_quote: socialPolicy("social_read_quote", "ip", 240, 60),
  social_trade_quote_anon: socialPolicy("social_trade_quote_anon", "ip", 20, 60),
  // The caller's own account, settings, profile editor and unread count.
  social_me_read: socialPolicy("social_me_read", "account", 300, 60),
  // Review L6: a deposit's first registration of a burn hash (which makes the
  // bridge relayer poll Circle), per client IP: the presale register route's
  // `presale_bridge_register` values.
  social_deposit_register: socialPolicy("social_deposit_register", "ip", 20, 600),
  // Review L4: wallet session cookies that name no live session, per client
  // IP, counted in memory. Each costs a session lookup on the primary; once
  // full, a cookie is not looked up until the window ends. A stale cookie is
  // cleared on its first failure, so a person makes a handful at most.
  social_auth_failure: socialPolicy("social_auth_failure", "ip", 60, 600),
});

/**
 * The coin page's market routes (WP2), per client IP. One open coin page
 * polls Holders, Activity (the classified list, the curve's flow and, after
 * migration, the venue's trades) and the chart (one or two pools) every
 * 15 s while visible: four reads a minute per route, eight for candles, plus
 * paging and control changes. The budgets leave room for many readers behind
 * one address (an office, a carrier NAT); `/status` is read only after a
 * refusal. The CDN serves most reads (`s-maxage`) before they count here.
 */
const LAUNCHPAD_MARKET_RATE_POLICIES: Readonly<Record<LaunchpadMarketRateBucket, RatePolicy>> = Object.freeze({
  launchpad_market_coin: launchpadMarketPolicy("launchpad_market_coin", 240, 60),
  launchpad_market_holders: launchpadMarketPolicy("launchpad_market_holders", 240, 60),
  launchpad_market_activity: launchpadMarketPolicy("launchpad_market_activity", 240, 60),
  // A hint reads the curve once per tab (Activity's flow and the page's figures share it) and, after migration, the venue pool.
  launchpad_market_pool: launchpadMarketPolicy("launchpad_market_pool", 480, 60),
  launchpad_market_candles: launchpadMarketPolicy("launchpad_market_candles", 480, 60),
  launchpad_market_trades: launchpadMarketPolicy("launchpad_market_trades", 240, 60),
  launchpad_market_status: launchpadMarketPolicy("launchpad_market_status", 120, 60),
  // The coin page's fees and reward rounds, polled like its other sections.
  launchpad_market_rewards: launchpadMarketPolicy("launchpad_market_rewards", 240, 60),
  launchpad_market_reward_rounds: launchpadMarketPolicy("launchpad_market_reward_rounds", 120, 60),
  // A wallet's own launches, fees and holder rewards: read on opening the portfolio and paging.
  launchpad_market_wallet_launch_rewards: launchpadMarketPolicy("launchpad_market_wallet_launch_rewards", 120, 60),
  launchpad_market_wallet_holder_rewards: launchpadMarketPolicy("launchpad_market_wallet_holder_rewards", 120, 60),
  launchpad_market_wallet_launches: launchpadMarketPolicy("launchpad_market_wallet_launches", 120, 60),
  // A reader's pending creator claims (LP-17): read on opening Rewards, after a claim, and paging.
  launchpad_market_creator_claims: launchpadMarketPolicy("launchpad_market_creator_claims", 120, 60),
  // The partner reads and the launchpad's policy: no page polls them.
  launchpad_market_partners: launchpadMarketPolicy("launchpad_market_partners", 120, 60),
  launchpad_market_partner: launchpadMarketPolicy("launchpad_market_partner", 120, 60),
  launchpad_market_partner_launches: launchpadMarketPolicy("launchpad_market_partner_launches", 120, 60),
  launchpad_market_policy: launchpadMarketPolicy("launchpad_market_policy", 60, 60),
});

function launchpadMarketPolicy(bucket: LaunchpadMarketRateBucket, limit: number, windowSeconds: number): RatePolicy {
  return Object.freeze({
    bucket,
    version: 1,
    subjectScope: "ip",
    windows: Object.freeze([Object.freeze({ limit, windowSeconds })]),
  });
}

function socialPolicy(
  bucket: SocialRateBucket,
  subjectScope: RateSubjectScope,
  limit: number,
  windowSeconds: number,
): RatePolicy {
  return Object.freeze({
    bucket,
    version: 1,
    subjectScope,
    windows: Object.freeze([Object.freeze({ limit, windowSeconds })]),
  });
}

export const DEFAULT_RATE_POLICIES = createRatePolicyRegistry();

export interface RateLimitSubject {
  ip?: string;
  address?: string;
  attemptId?: string;
  admissionId?: string;
  sessionId?: string;
  operation?: "issue" | "verify";
  /** A verified Privy DID. */
  accountId?: string;
  /** A verified agent key ID or partner key UUID, never the secret itself. */
  apiKeyId?: string;
}

function boundedPart(value: string | undefined): string | null {
  if (!z.string().min(1).max(255).regex(/^[^\0\r\n]*$/).safeParse(value).success) return null;
  return value as string;
}

function subjectPart(name: string, value: string | null): string | null {
  return value === null ? null : `${name}:${value}`;
}

export function rateLimitSubjectKey(
  policy: RatePolicy,
  subject: RateLimitSubject,
): string {
  const ip = boundedPart(subject.ip);
  const address = boundedPart(subject.address)?.toLowerCase() ?? null;
  const attempt = boundedPart(subject.attemptId);
  const admission = boundedPart(subject.admissionId);
  const session = boundedPart(subject.sessionId);
  const operation = boundedPart(subject.operation);
  const account = boundedPart(subject.accountId);
  const apiKey = boundedPart(subject.apiKeyId);
  const keys: Record<RateSubjectScope, string | null> = {
    ip: subjectPart("ip", ip),
    ip_address: ip && address
      ? `ip:${ip}\0address:${address}${operation ? `\0operation:${operation}` : ""}`
      : null,
    attempt: subjectPart("attempt", attempt),
    admission_or_session: subjectPart("admission", admission) ?? subjectPart("session", session),
    account: subjectPart("account", account),
    account_or_api_key: subjectPart("account", account) ?? subjectPart("api_key", apiKey),
    api_key: subjectPart("api_key", apiKey),
    // One part per count: a subject with both would hide which one is full.
    ip_and_account: ip && !account ? `ip:${ip}` : account && !ip ? `account:${account}` : null,
    global: "global",
  };
  const key = keys[policy.subjectScope];
  if (key) return key;
  throw new TypeError(`Missing ${policy.subjectScope} rate-limit subject.`);
}

export interface CountedWindow extends RateWindowPolicy {
  expiresAt: Date;
  startedAt: Date;
}

export interface RateLimitDecision {
  allowed: boolean;
  bucket: RateBucket;
  policyVersion: number;
  retryAfterSeconds: number;
}

/**
 * Every policy has at least one window, no two of the same length, and each
 * longer window a whole multiple of every shorter one. Windows start on
 * multiples of their own length, so then every boundary of a longer window is
 * also a boundary of each shorter one, which the refund in #refund relies on.
 * Divisibility is transitive, so checking neighbours in sorted order suffices.
 */
export function assertNestedWindows(
  policies: Readonly<Record<RateBucket, RatePolicy>>,
): void {
  for (const policy of Object.values(policies)) {
    const seconds = policy.windows.map((window) => window.windowSeconds).sort((a, b) => a - b);
    const nested = seconds.every((length, index) =>
      index === 0 || (length > seconds[index - 1] && length % seconds[index - 1] === 0));
    if (seconds.length === 0 || !nested) {
      throw new TypeError("Rate policy windows must be non-empty, distinct and nested (each a whole multiple of the shorter ones).");
    }
  }
}

/** The windows of `policy` that contain `now`, each starting on a multiple of its own length. */
export function countedWindows(policy: RatePolicy, now: Date): CountedWindow[] {
  return policy.windows.map((window) => {
    const windowMs = window.windowSeconds * 1_000;
    const startedAt = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    return { ...window, expiresAt: new Date(startedAt.getTime() + windowMs), startedAt };
  });
}

export interface RateLimitPort {
  consume(
    bucket: RateBucket,
    subject: RateLimitSubject,
  ): Promise<RateLimitDecision>;
  /** Atomic all-or-nothing admission when the storage supports it. */
  consumeAll?(
    buckets: readonly RateBucket[],
    subject: RateLimitSubject,
  ): Promise<RateLimitDecision>;
}

export async function withRateLimit<Result>(
  limiter: RateLimitPort,
  bucket: RateBucket,
  subject: RateLimitSubject,
  mutation: () => Promise<Result>,
): Promise<Result> {
  const decision = await limiter.consume(bucket, subject);
  if (!decision.allowed) throw new WebSecurityError("RATE_LIMITED");
  return mutation();
}

export type WalletRateSubject = Readonly<{ ip: string; address: string }>;

export interface WalletChallengeRateLimiter {
  consume(input: {
    operation: "issue" | "verify";
    subject: WalletRateSubject;
  }): Promise<Readonly<{ allowed: boolean; retryAfterSeconds: number }>>;
}

/** Takes `wallet_ip` first, so rotating addresses cannot multiply `wallet` (review L3). */
export function walletChallengeRateLimiter(limiter: RateLimitPort): WalletChallengeRateLimiter {
  const perAddress = walletAddressRateLimiter(limiter);
  return {
    async consume(input) {
      const perIp = await limiter.consume("wallet_ip", { ip: input.subject.ip });
      if (!perIp.allowed) return { allowed: false, retryAfterSeconds: perIp.retryAfterSeconds };
      return perAddress.consume(input);
    },
  };
}

/** Takes only `wallet`, for routes that already took `wallet_ip` before admission. */
export function walletAddressRateLimiter(limiter: RateLimitPort): WalletChallengeRateLimiter {
  return {
    async consume({ operation, subject }) {
      const decision = await limiter.consume("wallet", { ...subject, operation });
      return { allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds };
    },
  };
}
