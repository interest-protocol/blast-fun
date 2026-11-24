import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";

import { normalizeStructTag, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import type { SocialTransferFee } from "@blast/core/modules/social/contracts/coins.ts";
import {
  socialCommitInputSchema,
  SOCIAL_COMMIT_ROUTE,
  type CommitBlocker,
  type SocialCommitBuild,
  type SocialCommitPayCoin,
} from "@blast/core/modules/social/contracts/commit.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialJson, type SocialCaller, type SocialRequestContext, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { commitRoute, commitTransaction, type CommitChain } from "@blast/server/modules/social/commit/chain.ts";
import { swapCommitTransaction, type CommitSwapDependencies } from "@blast/server/modules/social/commit/swap.ts";
import type { PresaleSponsorService } from "@blast/server/modules/sponsor/service.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";

/**
 * The commit route: `POST /api/social/me/commits` (contract in
 * `contracts/commit.ts`).
 *
 * Why it exists: the commit is built against the presale deployment, and the
 * deployment is the server's `PRESALE_DEPLOYMENT_MANIFEST`, which no browser
 * bundle carries. The browser used to build the commit itself
 * (`commit-run.ts`) and so, with a manifest set, every commit in a real
 * browser refused before signing. The build moved here unchanged — the SDK's
 * `PresaleTransactions.commit` through `commitTransaction`, the Blast wallet
 * as sender and recipient, the leaf for an allowlisted sale, built as a
 * transaction kind with the wallet's own coins — and the browser signs and
 * submits what this answers, as the claim does (R3-63).
 *
 * The route is the claim route's shape: the shared social kit (account
 * required, its own `social_commit` bucket, `private, no-store`), a closed
 * body, published refusals, the mainnet deployment gate (`409
 * commit_unavailable` without one, `503` when its node does not answer), the
 * sale's types and shared version read from the chain (never the client's),
 * and nothing on the network inside a database transaction. It writes
 * nothing: the commit's registration (`POST /api/social/intents`, T-024) is
 * its row in the account's transaction log (R3-27), and it needs the digest,
 * which only exists once the sponsor has added the gas.
 */

export type SocialCommitRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /**
   * The mainnet presale deployment once its node answered with the right
   * chain, or null while committing is off (no `PRESALE_DEPLOYMENT_MANIFEST`,
   * or one naming another network). Throws when the node cannot be reached.
   */
  deployment: (signal?: AbortSignal) => Promise<PresaleRuntimeIdentity | null>;
  /** The chain reads and the build for that deployment (the presale node). */
  chain: (identity: PresaleRuntimeIdentity) => CommitChain;
  /** The caller's Blast wallet: a Privy session's embedded Sui wallet (null until it exists), a wallet session's own address. */
  blastWallet: (caller: SocialCaller) => Promise<string | null>;
  swap?: CommitSwapDependencies;
  /**
   * The presale sponsor in-process. A sponsored swap-and-commit reserves its gas here, as a
   * trade does: the public sponsor route admits only configured swap packages, never the
   * aggregator's whole route.
   */
  sponsor?: () => Pick<PresaleSponsorService, "sponsorServerCommit">;
}>;

const PAY_COIN_TYPES = Object.freeze({ USDC: PORTFOLIO_COIN_TYPES.usdc, SUI: PORTFOLIO_COIN_TYPES.sui });

type CommitInput = Readonly<{
  presaleId: string;
  payWith: SocialCommitPayCoin;
  atoms: bigint;
  swapQuoteId: string | null;
  allowlist: Readonly<{ index: bigint; walletCap: bigint; proof: string[] }> | null;
}>;

/** The closed body: a sale, a pay coin, a positive u64 amount, and at most one well-formed leaf. */
function parseCommit(body: unknown): CommitInput {
  const parsed = socialInput(socialCommitInputSchema, body);
  return {
    presaleId: parsed.presale_id,
    payWith: parsed.pay_with,
    atoms: BigInt(parsed.amount),
    swapQuoteId: parsed.swap_quote_id ?? null,
    allowlist: parsed.allowlist ?? null,
  };
}

/** Blast's gas pool pays every caller's network fee: a Privy embedded wallet and a wallet session alike (owner ruling 2026-11-20, reversing OA-17). */
const COMMIT_FEE: SocialTransferFee = "sponsored";

/** A sponsor refusal in the words this route publishes: budgets are `rate_limited`, a failed dry run is the swap's. */
function sponsorRefusal(error: unknown): unknown {
  if (!(error instanceof PresaleRouteError)) return error;
  switch (error.code) {
    case "rate_limited":
    case "budget_exceeded":
      return new SocialRouteError("rate_limited", { retryAfterSeconds: error.retryAfterSeconds ?? undefined });
    case "dry_run_failed":
      return unavailable(["swap_unavailable"]);
    case "not_embedded_wallet":
      return new SocialRouteError("blast_wallet_missing");
    default:
      return new SocialRouteError("service_unavailable", { retryAfterSeconds: error.retryAfterSeconds ?? undefined });
  }
}

/** `commit_unavailable`, naming the published blockers it stands for. */
function unavailable(reasons: readonly CommitBlocker[]): SocialRouteError {
  return new SocialRouteError("commit_unavailable", { extra: { reasons } });
}

export function createSocialCommitRoutes(dependencies: SocialCommitRouteDependencies) {
  const { kit, deployment, chain, blastWallet } = dependencies;

  async function handle(context: SocialRequestContext): Promise<Response> {
    const input = parseCommit(await readSocialJson(context.request, ["presale_id", "pay_with", "amount"], ["allowlist", "swap_quote_id"]));
    const caller = context.caller!;
    const fee = COMMIT_FEE;

    const wallet = await blastWallet(caller);
    if (wallet === null) throw new SocialRouteError("blast_wallet_missing");
    const sender = normalizeSuiAddress(wallet);
    const signal = context.request.signal;

    const identity = await deployment(signal);
    if (identity === null) {
      recordMetric("social.commit", { step: "build", outcome: "presale_not_deployed", fee });
      throw unavailable(["presale_not_deployed"]);
    }
    const reads = chain(identity);
    const presale = await reads.presale(input.presaleId, { signal });
    if (presale === null) {
      // `chain_read_v1` names a sale the manifest's package does not hold: not one Blast can commit to.
      recordMetric("social.commit", { step: "build", outcome: "not_this_deployment", fee });
      throw new SocialRouteError("not_found");
    }
    const route = commitRoute(presale);
    if (route === "allowlisted" && !input.allowlist) throw unavailable(["allowlist_unavailable"]);
    // The chain determines the quote type; the request cannot substitute another asset.
    const quoteType = normalizeStructTag(presale.quote);
    if (input.payWith !== "QUOTE" && quoteType !== PAY_COIN_TYPES[input.payWith]) {
      recordMetric("social.commit", { step: "build", outcome: "swap_unavailable", fee });
      throw unavailable(["swap_unavailable"]);
    }
    const held = input.swapQuoteId === null ? await reads.balance(sender, quoteType, { signal }) : input.atoms;
    if (held < input.atoms) {
      recordMetric("social.commit", { step: "build", outcome: "insufficient_balance", fee });
      throw new SocialRouteError("insufficient_balance");
    }

    const build = {
      identity,
      presale,
      saleToken: presale.saleToken,
      quoteType,
      atoms: input.atoms,
      recipient: sender,
      uncapped: route === "uncapped",
      allowlist: route === "allowlisted" && input.allowlist ? { ...input.allowlist, wallet: sender } : null,
    };
    if (input.swapQuoteId !== null && !dependencies.swap) throw unavailable(["swap_unavailable"]);
    const transaction = input.swapQuoteId === null
      ? commitTransaction(build)
      : await swapCommitTransaction(dependencies.swap!, { ...build, quoteId: input.swapQuoteId, accountId: context.account!.account_id, sender }, signal);
    const kind = await reads.kind(transaction, sender);
    const sponsored = await sponsorSwapCommit(caller, input, sender, kind, context.client.rateKey, signal);
    recordMetric("social.commit", { step: "build", outcome: "built", route, fee });
    const answer: SocialCommitBuild = {
      presale_id: input.presaleId,
      sender,
      fee,
      route,
      quote_type: quoteType,
      amount: input.atoms.toString(),
      transaction_kind_bytes: toBase64(kind),
      ...sponsored,
    };
    return context.json(answer, 200);
  }

  /** A swap-and-commit carries its sponsored bytes, for a Privy account and a wallet session alike; a plain commit carries none. */
  async function sponsorSwapCommit(caller: SocialCaller, input: CommitInput, sender: string, kind: Uint8Array, ip: string, signal: AbortSignal): Promise<Pick<SocialCommitBuild, "sponsored">> {
    if (input.swapQuoteId === null) return {};
    if (!dependencies.sponsor) throw unavailable(["swap_unavailable"]);
    try {
      const reserved = await dependencies.sponsor().sponsorServerCommit({ caller, presaleId: input.presaleId, sender, kindBytes: kind, intent: "commit", ip, signal });
      return { sponsored: { reservation_id: reserved.reservation_id, transaction_bytes: reserved.transaction_bytes, expires_at_ms: reserved.expires_at_ms } };
    } catch (error) {
      recordMetric("social.commit", { step: "sponsor", outcome: "refused", code: error instanceof PresaleRouteError ? error.code : "error" });
      throw sponsorRefusal(error);
    }
  }

  return Object.freeze({
    build: kit.route({ name: SOCIAL_COMMIT_ROUTE, auth: "account", account: "required", bucket: "social_commit", cache: "private" }, handle),
  });
}

export type SocialCommitRoutes = ReturnType<typeof createSocialCommitRoutes>;
