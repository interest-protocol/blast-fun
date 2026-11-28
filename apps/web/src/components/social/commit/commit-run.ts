import { diagnosticMessage } from "#web/lib/errors.ts";
import type { AllowlistProof } from "@interest-protocol/blast-sdk/presale";

import type { CommitBlocker } from "@blast/core/web/contracts/commit.ts";
import { saleIsOpen, toAtoms, type CommitSale } from "@blast/core/modules/social/commit/quote.ts";

import type { SocialApiOptions } from "#web/components/social/social-api.ts";
import { COMMIT_COIN_DECIMALS } from "./commit-view";
import type { SponsoredSigner } from "#web/components/social/sponsored-transaction.ts";
import { runCommit, type CommitPhase, type CommitResult } from "./commit-flow";
import type { CommitBlastInput } from "./CommitPanel";

/**
 * One blast, from what the panel holds to a digest: the commitment in the
 * sale's quote-coin atoms and, for an allowlisted sale, the wallet's leaf,
 * handed to the flow, which has the server build the commit
 * (`POST /api/social/me/commits`) and then signs and submits it.
 *
 * The browser builds nothing against the presale deployment: the deployment
 * is the server's `PRESALE_DEPLOYMENT_MANIFEST`, which no browser bundle
 * carries, so the server reads the sale's object and builds the commit.
 *
 * This module is imported dynamically by the host, so the flow (Sui's
 * transaction builder and BCS) is not in the first load of a page where
 * nobody blasts.
 *
 * `blockers` is checked first and again inside `runCommit`: nothing is asked
 * of the server and nothing is signed while blasting is off.
 */
export async function runCommitFor(input: Readonly<{
  api: SocialApiOptions;
  signer: SponsoredSigner;
  blockers: readonly CommitBlocker[];
  sale: CommitSale;
  input: CommitBlastInput;
  sourceEntryId: string | null;
  /** The wallet's leaf, for an allowlisted sale (`allowlistLeafOf`); null otherwise. */
  allowlist: AllowlistProof | null;
  /** Reported as the flow moves (`runCommit`'s own steps), so a button can say what is happening. */
  onPhase?: (phase: CommitPhase) => void;
}>): Promise<CommitResult> {
  if (input.blockers.length > 0) return { status: "blocked", reasons: input.blockers };
  // The time is read here: a screen's clock pauses in a hidden tab, so it can still show an ended sale as open.
  if (!saleIsOpen(input.sale, Date.now())) {
    return { status: "failed", message: diagnosticMessage("This presale is not open for purchases. Nothing was sent.", { code: "commit_unavailable" }), digest: null };
  }
  if (input.input.payWith !== input.sale.quoteCoin) return { status: "failed", message: "Choose a payment coin in the presale form. Nothing was sent.", digest: null };
  // An allowlisted sale takes only `commit_allowlisted` with the wallet's own
  // leaf; the open route would abort on chain. No leaf, nothing is asked for.
  if (input.sale.allowlisted && input.allowlist === null) {
    return { status: "failed", message: diagnosticMessage("You’re not on this sale’s allowlist. Nothing was sent.", { code: "not_eligible" }), digest: null };
  }

  // The sale's own decimals as the view gives them (R3-41), the coin's known ones for a sale built without them.
  const atoms = input.input.quoteAtoms === undefined
    ? toAtoms(input.input.quote, input.sale.quoteDecimals ?? COMMIT_COIN_DECIMALS[input.sale.quoteCoin])
    : BigInt(input.input.quoteAtoms);
  const leaf = input.sale.allowlisted ? input.allowlist : null;
  return runCommit(
    { api: input.api, signer: input.signer, blockers: input.blockers, onPhase: input.onPhase },
    {
      presaleId: input.sale.presaleId,
      order: {
        payWith: "QUOTE",
        amount: atoms.toString(),
        ...(input.input.swapQuoteId ? { swapQuoteId: input.input.swapQuoteId } : {}),
        // The leaf as the presale proof route answered it; the server proves it for the Blast wallet.
        allowlist: leaf ? { index: leaf.index.toString(), wallet_cap: leaf.walletCap.toString(), proof: [...leaf.proof] } : null,
      },
      sourceEntryId: input.sourceEntryId,
      why: input.input.why,
      // The dollar value at submission, for the account's log (R3-27); the coin and atoms are the built commit's.
      usdValue: input.input.usd > 0 ? input.input.usd.toFixed(2) : null,
    },
  );
}
