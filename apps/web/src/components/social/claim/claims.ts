import { diagnosticMessage } from "#web/lib/errors.ts";
/**
 * Blast mode's claim buttons (FEATURE-MAP-R3 §15.9, R3-58): what a claim is
 * asked to do, what it can answer, the one busy verb and the shared refusal
 * copy. Pure, so every state and string is a test.
 *
 * The claim transaction itself is R3-63's (`components/social/claim/`): the
 * shell's `ClaimPath`, which every claim button reaches through
 * `useShellClaimPath`: Blast mode's presale panel (`WorkspacePresalePanel`),
 * the sale page's `SaleAside`, the presales aside and the portfolio. This
 * file is the seam it plugs into and
 * everything the reader sees around it: `Claiming` while it runs, a published
 * refusal when it fails, the item staying where it was.
 *
 * What a `ClaimPath` does, so the failure is never silent (§22.1 defect 2):
 *
 * 1. Records the attempt in the account's transaction log (R3-27,
 *    `transactions/log.ts` `logTransaction`) **before** it asks the wallet to
 *    sign — `kind` = the target's kind, key `<kind>:<request id>`, no digest —
 *    then the digest, then the outcome, through its own server step,
 *    `PUT /api/social/me/claims/{request_id}` (shaped like the withdrawal's
 *    transfers route).
 * 2. Answers `confirmed` with the digest, or `failed` with a **published code**
 *    — one of `SOCIAL_TRANSACTION_FAILURES`, a route refusal code or one of
 *    the claim's own (`already_claimed`, `claim_not_open`) — never a raw
 *    chain error string.
 * 3. Says which kinds it can claim (`kinds`); a button whose kind it cannot
 *    claim is not drawn (the shell's claims all three: refunds, tokens and,
 *    since P-13, vested shares).
 *
 * The screen then reads the log again, so a failed attempt shows up in
 * `This session` as a failed row.
 */

import { SOCIAL_TRADE_ONLY_FAILURES, SOCIAL_TRANSACTION_FAILURES } from "@blast/core/web/contracts/transactions.ts";

/** A launch's creator rights (LP-17): its `CurveFeeCap` and `BlastMetadataCap`, claimed together. */
export const CREATOR_CAPS_KIND = "claim_creator_caps";

/** What can be claimed: a sale's claims and creator actions, a launch creator's fees (LP-12) and creator rights (LP-17). */
export type ClaimKind =
  | import("@blast/core/web/contracts/claims.ts").SocialClaimKind
  | import("@blast/core/web/contracts/launch-claims.ts").LaunchClaimKind
  | typeof CREATOR_CAPS_KIND;

type ClaimTargetBase = Readonly<{
  /** One per claimable thing: `refund:<sale>`, `tokens:<sale>`, `vesting:<schedule>`, `launch-fees:<launch>`. */
  key: string;
  /** Indexed cumulative fee receipt, so a confirmed collection can be repeated after refresh. */
  collection?: Readonly<{ received: string }>;
  /** The private schedule snapshot at the press; whole-token decimals, never floats. */
  vesting?: Readonly<{ claimed: string; claimable: string }>;
  /** What the success toast says, already in the gate's words (`$250 refund claimed`). */
  done: Readonly<{ title: string; sub: string }>;
}>;

/** A sale's claim or a presale creator action. */
export type PresaleClaimTarget = ClaimTargetBase &
  Readonly<{
    kind: import("@blast/core/web/contracts/claims.ts").SocialClaimKind;
    presaleId: string;
    /** The vesting schedule, for `claim_vesting`. */
    scheduleId?: string;
    vaultId?: string;
  }>;

/** A launch creator's fees (LP-12): the curve's, or the migration vault's. It names no sale. */
export type LaunchClaimTarget = ClaimTargetBase &
  Readonly<{
    kind: import("@blast/core/web/contracts/launch-claims.ts").LaunchClaimKind;
    launchId: string;
    presaleId?: never;
    scheduleId?: never;
    vaultId?: never;
  }>;

/** A launch's creator rights (LP-17): both caps to the Blast wallet, for a launch that names its wallet or account. */
export type CreatorCapsClaimTarget = ClaimTargetBase &
  Readonly<{
    kind: typeof CREATOR_CAPS_KIND;
    launchId: string;
    presaleId?: never;
    scheduleId?: never;
    vaultId?: never;
  }>;

export type ClaimTarget = PresaleClaimTarget | LaunchClaimTarget | CreatorCapsClaimTarget;

/** Whether `target` is a launch creator's fee claim. */
export function isLaunchClaimTarget(target: ClaimTarget): target is LaunchClaimTarget {
  return target.kind === "claim_launch_fees" || target.kind === "claim_launch_lp_fees";
}

/** Whether `target` is a launch's creator-rights claim. */
export function isCreatorCapsClaimTarget(target: ClaimTarget): target is CreatorCapsClaimTarget {
  return target.kind === CREATOR_CAPS_KIND;
}

/** A launch's creator rights, with the same key wherever it is pressed. */
export function creatorCapsClaimTarget(launch: Readonly<{ launchId: string; name: string }>): CreatorCapsClaimTarget {
  return {
    key: `creator-caps:${launch.launchId}`,
    kind: CREATOR_CAPS_KIND,
    launchId: launch.launchId,
    done: { title: "Creator rights claimed", sub: `${launch.name} · its fees are now yours to claim` },
  };
}

/**
 * A launch's creator fees in one ledger, with the same key wherever it is pressed. `claimed` is
 * the ledger's cumulative claimed `meme:quote`, so once a confirmed claim is indexed (it grew)
 * fees that accrue later can be claimed again.
 */
export function launchClaimTarget(
  launch: Readonly<{ launchId: string; name: string }>,
  ledger: Readonly<{ vault: boolean; claimed: string }>,
): LaunchClaimTarget {
  return {
    key: `${ledger.vault ? "launch-lp-fees" : "launch-fees"}:${launch.launchId}`,
    kind: ledger.vault ? "claim_launch_lp_fees" : "claim_launch_fees",
    launchId: launch.launchId,
    collection: { received: ledger.claimed },
    done: { title: "Creator fees claimed", sub: `${launch.name} · now in your wallet` },
  };
}

/**
 * A sale's refund or tokens claim, with the same key and toast wherever it is
 * pressed — the sale page, Portfolio's Presales tab, "Your presales" — so a
 * claim started in one place is one claim everywhere. `refund` is the refund
 * as the toast says it, the gate's `usd(amt, 2)` (`$250.00 refund claimed`;
 * R3-40: it names the coin it comes back in).
 */
export function saleClaimTarget(
  kind: "claim_refund" | "claim_tokens",
  sale: Readonly<{ presale_id: string; name: string; symbol: string; quote_symbol: string }>,
  refund: string,
  tokens: string | null = null,
  vested = false,
): PresaleClaimTarget {
  return kind === "claim_refund"
    ? { key: `refund:${sale.presale_id}`, kind, presaleId: sale.presale_id, done: { title: `${refund} refund claimed`, sub: `From ${sale.name}, now in your ${sale.quote_symbol}` } }
    : { key: `tokens:${sale.presale_id}`, kind, presaleId: sale.presale_id, done: { title: vested ? "Your buyer vesting has started" : tokens === null ? `Claimed your ${sale.symbol}` : `Claimed ${tokens}`, sub: vested ? `${sale.name} · tokens in your vesting schedule` : `${sale.name} · now in your wallet` } };
}

export type ClaimOutcome =
  | Readonly<{ status: "confirmed"; digest: string }>
  | Readonly<{ status: "failed"; code: string; requestId?: string; digest?: string }>;

/**
 * The claim transaction, end to end: record, build, sponsor, sign, execute and
 * settle (R3-63). Without one no claim button renders, because a control that
 * cannot act is worse than a missing one; `kinds`, when present, are the only
 * kinds it can claim, and a button of any other kind is not drawn either.
 */
export type ClaimPath = ((target: ClaimTarget, signal: AbortSignal) => Promise<ClaimOutcome>) &
  Readonly<{ kinds?: readonly ClaimKind[] }>;

/** Whether `path` can claim `kind` (a path that names no kinds claims every one). */
export function claimPathSupports(path: ClaimPath | undefined, kind: ClaimKind): boolean {
  return path !== undefined && (path.kinds === undefined || path.kinds.includes(kind));
}

/** A claim's state on screen. `done` keeps the digest for the toast's link until the reads move the item away. */
export type ClaimView =
  | Readonly<{ state: "idle" }>
  | Readonly<{ state: "claiming" }>
  | Readonly<{ state: "failed"; code: string; message: string; digest?: string }>
  | Readonly<{ state: "done"; digest: string }>;

export const CLAIM_IDLE: ClaimView = Object.freeze({ state: "idle" });

/** Every busy button in Blast mode names what it is doing (§22.1 defect 3: the vesting claim's bare spinner). */
export const CLAIMING = "Claiming";

/** A path that threw (a network failure, a bug) rather than answering: the code the screen shows for it. */
export const CLAIM_UNREACHABLE = "claim_unreachable";

const PUBLISHED_SHAPE = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * The code a failure is shown with. Anything that is not shaped like a
 * published code (`^[a-z][a-z0-9_]{2,63}$`, the log's own CHECK) — a raw
 * `MoveAbort(…)` string, an empty value — is not repeated to the reader.
 */
export function publishedClaimCode(code: unknown): string {
  return typeof code === "string" && PUBLISHED_SHAPE.test(code) ? code : CLAIM_UNREACHABLE;
}

/**
 * The shared refusal copy for a claim (OA-13: the gate has none; its claims
 * fail silently). Each line says what happened and that nothing moved, as the
 * withdrawal's refusals do.
 */
export function claimRefusalCopy(code: string, requestId?: string): string {
  return diagnosticMessage(claimRefusalDescription(code), { code, requestId });
}

/** Plain recovery copy for the toast; diagnostic codes remain in the transaction log. */
export function claimRefusalDescription(code: string): string {
  switch (code) {
    case "rejected":
      return "You declined it in your wallet. Nothing was claimed.";
    case "dry_run_failed":
      return "This claim would fail on Sui. Nothing was claimed.";
    case "execution_failed":
      return "The claim failed on Sui. Nothing moved.";
    case "sponsor_refused":
      return "Blast couldn't sponsor this transaction. Nothing was sent.";
    case "expired":
      return "The claim ran out of time before it was sent. Try again.";
    case "mismatch":
      return "That transaction isn't this claim. Nothing was claimed.";
    case "already_claimed":
    case "nothing_to_claim":
      return "There's nothing left to claim here. It may already be in your wallet.";
    case "claim_not_open":
      return "This sale can't be claimed yet. Claims open once it launches or is cancelled.";
    case "claim_unavailable":
      return "Claiming isn't open yet. Nothing was claimed.";
    // A launch's creator rights (LP-17).
    case "not_creator_recipient":
      return "This launch names another wallet or account as its creator. Nothing was claimed.";
    case "creator_caps_claimed":
      return "These creator rights were already claimed. Nothing was claimed here.";
    case "attestation_expired":
      return "Blast's approval for this claim ran out before it was sent. Nothing was claimed. Claim again for a new one.";
    case "claim_conflict":
      return "This claim changed while it ran. Try again.";
    case "sign_failed":
      return "Your wallet couldn't sign it. Nothing was claimed.";
    case "claim_pending":
      return "Sent. It hasn't shown up on Sui yet. Check back in a moment.";
    case "claim_unsupported":
      return "This can't be claimed from Blast yet.";
    case "blast_wallet_missing":
    case "not_embedded_wallet":
      return "Your Blast wallet is not ready. Reload and try again.";
    case "rate_limited":
    case "budget_exceeded":
      return "Too many claims for now. Try again in a minute.";
    case "pool_unavailable":
    case "deployment_unavailable":
    case "deployment_mismatch":
    case "service_unavailable":
      return "Claims are paused for a moment. Nothing was claimed. Try again soon.";
    case "unauthorized":
    case "account_required":
      return "Sign in again to claim.";
    case CLAIM_UNREACHABLE:
      return "The claim couldn't reach Blast. Nothing was claimed. Try again.";
    default:
      return "The claim didn't go through. Nothing was claimed.";
  }
}

/** The short reason a failed row of `This session` gives, after `Failed:`. */
export function failureShort(code: string | null): string {
  switch (code) {
    case "rejected":
      return "declined in your wallet";
    case "dry_run_failed":
      return "it would have failed on Sui";
    case "execution_failed":
      return "it failed on Sui";
    case "sponsor_refused":
      return "sponsorship was refused";
    case "expired":
      return "it ran out of time";
    case "mismatch":
      return "the transaction didn't match";
    // A trade's own (R3-31), as the session list shows a failed trade.
    case "quote_expired":
      return "the price expired";
    case "price_moved":
      return "the price moved";
    case "insufficient_balance":
      return "not enough to cover it";
    case "pool_unavailable":
      return "the pool couldn't take it";
    default:
      return "it didn't go through";
  }
}

/** The view after a path answered (or threw). */
export function claimSettled(outcome: ClaimOutcome | null): ClaimView {
  if (outcome !== null && outcome.status === "confirmed") return { state: "done", digest: outcome.digest };
  const code = publishedClaimCode(outcome === null ? null : outcome.code);
  const digest = outcome?.status === "failed" ? outcome.digest : undefined;
  return {
    state: "failed",
    code,
    ...(digest ? { digest } : {}),
    message: digest ? diagnosticMessage(`Your claim is awaiting confirmation. Check ${digest} on Sui before claiming again.`, { code, requestId: outcome?.status === "failed" ? outcome.requestId : undefined }) : claimRefusalCopy(code, outcome?.status === "failed" ? outcome.requestId : undefined),
  };
}

/** Retry only failures that can recover without another prerequisite or an unresolved transaction. */
export function claimCanRetry(view: ClaimView): boolean {
  if (view.state !== "failed" || view.digest) return false;
  return !["claim_pending", "already_claimed", "not_creator_recipient", "creator_caps_claimed", "nothing_to_claim", "claim_not_open", "claim_unavailable", "claim_unsupported", "unauthorized", "account_required", "blast_wallet_missing", "not_embedded_wallet"].includes(view.code);
}

/** The button's words: its own label while idle or after a refusal, `Claiming` while it runs. */
export function claimButtonText(view: ClaimView, label: string, kind?: ClaimKind): string {
  if (label === "Start your vesting") return { idle: label, failed: label, done: "Vesting started", claiming: "Starting vesting" }[view.state];
  return standardClaimButtonText(view, label, kind);
}

function standardClaimButtonText(view: ClaimView, label: string, kind?: ClaimKind): string {
  if (label.startsWith("Claim ") && (kind === "claim_tokens" || kind === "claim_vesting") && (view.state === "claiming" || view.state === "done")) {
    return label.replace(/^Claim /, view.state === "done" ? "Claimed " : "Claiming ");
  }
  if (kind === "collect_fees") return view.state === "done" ? "Collected" : view.state === "claiming" ? "Collecting fees" : label;
  return view.state === "done" ? "Claimed" : view.state === "claiming" ? CLAIMING : label;
}

/**
 * The log's published failures a claim can carry, so a test can prove each
 * one has its own copy: all of them but a trade's own (R3-31), which a claim
 * never logs.
 */
export const LOGGED_CLAIM_FAILURES = SOCIAL_TRANSACTION_FAILURES.filter(
  (code) => !(SOCIAL_TRADE_ONLY_FAILURES as readonly string[]).includes(code),
);

/** Every published failure the session list may show, a trade's included. */
export const LOGGED_FAILURES = SOCIAL_TRANSACTION_FAILURES;
