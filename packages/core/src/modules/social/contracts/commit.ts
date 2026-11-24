import { socialAtomsSchema, socialPositiveAtomsSchema } from "./primitives.ts";
import { z } from "zod";
import {
  financialAddressSchema,
  financialTextSchema,
  financialAtomsSchema,
  financialPositiveAtomsSchema,
  financialPlainCoinTypeSchema,
  financialBase64Schema,
  type FinancialReadonly,
} from "./financial-wire.ts";
/**
 * The commit dialog's gating contract (T-028, with OA-7's dialog instead of
 * T-028's inline panel).
 *
 * Blasting signs a transaction against the presale package, so it is off for
 * exactly as long as Create's publishing is, and for the same reason: the web
 * reads its deployment from the `PRESALE_DEPLOYMENT_MANIFEST` env JSON
 * (`readPresaleDeploymentIdentity`), and without a manifest naming a mainnet
 * package there is nothing to sign against. Each reason is named, published,
 * and safe to show and to log — `CREATE_PUBLISH_BLOCKERS` is the pattern.
 *
 * The dialog still opens, still quotes, and still takes a why: the person sees
 * the terms and one line saying when they can blast. Nothing is built for
 * signing, and the signing path is unreachable (`commitAvailability` is
 * checked when the dialog opens and again at the press).
 *
 * The server refusals behind the same wall already exist in presale scope:
 * `POST /api/presale/sponsor` answers `deployment_unavailable` /
 * `deployment_mismatch`, and so does the allowlist proof. The social published
 * code `commit_unavailable` carries this list wherever a social route has to
 * say it.
 */
export const COMMIT_BLOCKERS = [
  /** No `PRESALE_DEPLOYMENT_MANIFEST`, a malformed one, or one that is not mainnet. */
  "presale_not_deployed",
  /** The viewer has no Sui wallet to commit from yet (an embedded wallet still being created). */
  "wallet_missing",
  /** The sale's allowlist could not be read, so an allowlisted commit cannot be proven. */
  "allowlist_unavailable",
  /**
   * The chosen pay coin is not the sale's quote coin, so the commitment would
   * have to be swapped on the way in. `blast_presale::commit_*` takes the
   * quote coin only, so the swap is a Cetus aggregator route prepended to the
   * PTB — the quote service and swap path of R3 Wave 3/4, which this run
   * descoped. The reference draws the toggle and prints "swapped to USDC for
   * you"; the product shows the terms and says it cannot do the swap yet,
   * rather than building a transaction that would abort.
   */
  "swap_unavailable",
] as const;
export type CommitBlocker = (typeof COMMIT_BLOCKERS)[number];

export type CommitAvailability =
  | Readonly<{ available: true }>
  | Readonly<{ available: false; reasons: readonly CommitBlocker[] }>;

/**
 * Why blasting is off, in a fixed order, from facts both sides of the wire
 * have. The server reads `deployed` from the manifest
 * (`commit/chain.ts commitAvailability`); the browser is told it by the page,
 * and adds the pay coin's own reason when the toggle moves. One list, so the
 * dialog and any server refusal can never disagree.
 */
export function commitBlockers(
  input: Readonly<{
    /** A mainnet presale deployment exists and parsed. */
    deployed: boolean;
    /** The viewer's Blast wallet, or null while it does not exist yet. */
    wallet: string | null;
    /** An allowlisted sale whose allowlist could not be read at all (not merely "not on it"). */
    allowlistUnreadable?: boolean;
    /** The coin the person chose to pay with, and the coin the sale raises in. */
    payWith?: string;
    quoteCoin?: string;
  }>,
): readonly CommitBlocker[] {
  const reasons: CommitBlocker[] = [];
  if (!input.deployed) reasons.push("presale_not_deployed");
  if (!input.wallet) reasons.push("wallet_missing");
  if (input.allowlistUnreadable) reasons.push("allowlist_unavailable");
  if (
    input.payWith !== undefined &&
    input.quoteCoin !== undefined &&
    input.payWith !== input.quoteCoin
  ) {
    reasons.push("swap_unavailable");
  }
  return reasons;
}

/** A reason list as an availability answer. */
export function commitAvailabilityOf(
  reasons: readonly CommitBlocker[],
): CommitAvailability {
  return reasons.length > 0
    ? { available: false, reasons }
    : { available: true };
}

/**
 * Why blasting is off, in the dialog's words: one line, whatever the reasons,
 * in the order they matter to the person reading it. `publishOffLine`
 * (Create's) is the pattern, and the sale page's existing "Commits open here
 * once the sale contract is live on Sui." is the sentence this extends.
 */
export function commitOffLine(reasons: readonly CommitBlocker[]): string {
  if (reasons.includes("presale_not_deployed")) {
    return "Blasting opens once the sale contract is live on Sui mainnet. Nothing is sent until then.";
  }
  if (reasons.includes("wallet_missing"))
    return "Your Blast wallet is still being set up. Try again in a moment.";
  if (reasons.includes("allowlist_unavailable"))
    return "This sale’s allowlist could not be read, so blasting is off for a moment.";
  if (reasons.includes("swap_unavailable"))
    return "A swap into this sale’s coin is unavailable or the quote changed. Refresh the quote or pay with the coin it raises in.";
  return "Blasting isn’t available for this sale yet.";
}

/**
 * The commit transaction, built on the server: `POST /api/social/me/commits`.
 *
 * The deployment manifest (`PRESALE_DEPLOYMENT_MANIFEST`) is a server
 * environment variable that never reaches a browser bundle, so the browser
 * cannot build a commit. It asks this route instead, exactly as the claim
 * asks `PUT /api/social/me/claims/{request_id}` (R3-63): the server builds
 * the commit with the presale SDK for the caller's own Blast wallet and
 * answers the transaction kind; the browser only signs and submits it —
 * sponsored (the presale sponsor's `commit` intent) for a Privy embedded
 * wallet and a Slush session alike (OA-16; owner ruling 2026-11-20 reversed
 * OA-17) — and
 * registers the digest with `POST /api/social/intents` before it executes
 * (T-024), which is also the commit's row in the account's transaction log
 * (R3-27: every commit is registered and logged).
 *
 * Signed in with an account, bucket `social_commit`, `private, no-store`.
 * Nothing is written: a build is not an attempt until it has a digest, and
 * the registration records that. The why and the post a commit came through
 * travel with the registration, not here, so the why's text reaches one route
 * only (AC-130).
 *
 * The body (closed): the sale, the coin the person pays with, the amount in
 * the sale's quote-coin atoms, and for an allowlisted sale the Blast wallet's
 * leaf as `GET /api/presale/presales/{id}/proof` answers it. An optional sealed
 * `swap_quote_id` funds a quote-coin commitment from another wallet coin in the
 * same transaction, returning surplus quote coins and presale change to the sender. The route reads
 * the sale's object from the deployment's node (its type arguments and shared
 * version — never the client's) and the wallet's balance of the quote coin,
 * then builds `PresaleTransactions.commit` (`commit_open`, or
 * `commit_allowlisted` with the leaf) as a transaction kind with the wallet's
 * own coins.
 *
 * Answers `200` with the kind. Refusals besides the kit's: `400
 * invalid_request` (the body), `404 not_found` (the id is not a presale of
 * this deployment), `409 blast_wallet_missing`, `409 commit_unavailable` with
 * `reasons` (`presale_not_deployed`: no manifest naming a mainnet package;
 * `swap_unavailable`: no executable swap into the sale's quote coin), `409
 * insufficient_balance` (the Blast wallet holds less of the quote coin than
 * the amount), `503 service_unavailable` (the node or the database).
 */
export const SOCIAL_COMMIT_ROUTE = "POST /api/social/me/commits";
export const SOCIAL_COMMITS_PATH = "/api/social/me/commits";

/** Every commit pays in the sale's exact on-chain quote type. */
export const SOCIAL_COMMIT_PAY_COINS = ["QUOTE"] as const;
export type SocialCommitPayCoin = (typeof SOCIAL_COMMIT_PAY_COINS)[number];

/** The `blast_presale::commit_*` entry a commit is built through (`commit/chain.ts commitRoute`). */
export const SOCIAL_COMMIT_ROUTES = ["open", "allowlisted", "uncapped"] as const;
export type SocialCommitRoute = (typeof SOCIAL_COMMIT_ROUTES)[number];

/** The Blast wallet's allowlist leaf, as the presale proof route answers it (u64 strings; proof entries 64 hex, no `0x`). */
export const socialCommitAllowlistSchema = z.strictObject({
  index: financialAtomsSchema,
  wallet_cap: financialAtomsSchema,
  proof: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .max(16)
    .describe(
      "A Merkle proof, leaf to root; at most 16 entries (65,536 leaves); 32 bytes as 64 lowercase hex characters without 0x.",
    ),
});

export type SocialCommitAllowlist = FinancialReadonly<
  z.infer<typeof socialCommitAllowlistSchema>
>;

export const socialCommitRequestSchema = z
  .strictObject({
    presale_id: financialAddressSchema,
    pay_with: z.enum(SOCIAL_COMMIT_PAY_COINS),
    amount: financialPositiveAtomsSchema.describe(
      "A u64 of quote-coin atoms, at least 1.",
    ),
    allowlist: socialCommitAllowlistSchema.optional(),
    swap_quote_id: financialTextSchema({ minLength: 1, maxLength: 3000 })
      .describe(
        "An offered, sealed swap into the presale's exact quote type. amount is its guaranteed min_out.",
      )
      .optional(),
  })
  .meta({
    title: "Build a presale commit for the Blast wallet",
    description:
      "POST /api/social/me/commits: the sale, its exact on-chain quote coin selected by QUOTE, the commitment in the sale's quote-coin atoms, and for an allowlisted sale the Blast wallet's leaf as the presale proof route answers it.",
  });

export type SocialCommitRequest = FinancialReadonly<
  z.infer<typeof socialCommitRequestSchema>
>;

export const socialCommitBuildSchema = z
  .strictObject({
    presale_id: financialAddressSchema,
    sender: financialAddressSchema,
    fee: z.enum(["sponsored", "wallet"]),
    route: z.enum(SOCIAL_COMMIT_ROUTES),
    quote_type: financialPlainCoinTypeSchema,
    amount: financialPositiveAtomsSchema,
    transaction_kind_bytes: financialBase64Schema
      .max(174764)
      .describe(
        "Standard base64; at most Sui's 128 KiB transaction size (a wallet's many coins are merged inside it).",
      ),
    sponsored: z
      .strictObject({
        reservation_id: z.string().min(1).max(128),
        transaction_bytes: financialBase64Schema.max(174764),
        expires_at_ms: z.number().int().positive(),
      })
      .optional()
      .describe(
        "A sponsored swap-and-commit: the gas reservation the server already made for exactly this kind. The browser signs transaction_bytes and executes the reservation; it does not ask POST /api/presale/sponsor.",
      ),
  })
  .meta({
    title: "A presale commit to sign",
    description:
      "POST /api/social/me/commits 200: the commit the server built with the presale SDK for the caller's Blast wallet, as a transaction kind (no sender, no gas) for the browser to sign and submit.",
  });

export type SocialCommitBuild = FinancialReadonly<
  z.infer<typeof socialCommitBuildSchema>
>;

export const socialCommitLeafInputSchema = socialCommitAllowlistSchema
  .extend({
    index: socialAtomsSchema,
    wallet_cap: socialAtomsSchema,
  })
  .transform(({ index, wallet_cap, proof }) => ({
    index: BigInt(index),
    walletCap: BigInt(wallet_cap),
    proof,
  }));

/** The route has always treated a null swap quote as absent. */
export const socialCommitInputSchema = socialCommitRequestSchema.extend({
  amount: socialPositiveAtomsSchema,
  swap_quote_id: z.string().min(1).max(3000).nullish(),
  allowlist: socialCommitLeafInputSchema.optional(),
});
