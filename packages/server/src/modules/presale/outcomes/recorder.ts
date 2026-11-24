import { z } from "zod";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import { errorLabel } from "@blast/core/lib/metrics.ts";
import {
  OUTCOME_PRIVY_TIMEOUT_MS,
  type OutcomeUnavailable,
  type TransactionRefusal,
} from "@blast/server/modules/launchpad-telemetry/outcomes.ts";
import { recordPresaleMetric } from "@blast/core/modules/presale/redaction/redaction.ts";
import type { PresaleOutcomeStore, PresaleRecordResult } from "./store.ts";
import type {
  PresaleCommitRefusal,
  PresaleOutcomeVerifier,
} from "./verifier.ts";

export type PresaleOutcomeRecorderDependencies = Readonly<{
  store: PresaleOutcomeStore;
  verify: PresaleOutcomeVerifier;
  /** The Privy account's embedded Sui wallet (`presaleEmbeddedWallets().find`), or null without one. */
  embeddedWallet: (privyDid: string) => Promise<string | null>;
  /** The longest an embedded-wallet lookup may take; past it nobody is linked through Privy. */
  identityTimeoutMs?: number;
  /** Waits between a sponsored commit's attempts while its transaction is pending (`recordSponsoredCommit`). */
  pendingRetryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}>;

export type PresaleOutcomeResult =
  | Readonly<{ status: PresaleRecordResult }>
  /** The transaction holds no `Committed` of the sale, or the node has not checkpointed it yet. */
  | Readonly<{
      status: "not_found";
      reason: TransactionRefusal | PresaleCommitRefusal;
    }>
  /** The node cannot answer now. */
  | Readonly<{
      status: "unavailable";
      reason: OutcomeUnavailable | "storage-unavailable";
    }>;

export type PresaleOutcomeInput = Readonly<{
  presaleId: string;
  txDigest: string;
  /** The reporting browser's visitor; linked only with a Privy session for the sender. */
  visitorId: string | null;
  /** The reporter's verified Privy account; linked only when its embedded wallet is the sender. */
  privyDid: string | null;
}>;

export type PresaleOutcomeRecorder = Readonly<{
  /** Verifies and records one report (`POST /api/presale/outcomes`). Storage failures propagate. */
  record(input: PresaleOutcomeInput): Promise<PresaleOutcomeResult>;
  /**
   * For the sponsored execute route (T-018), with no browser call: records the
   * `Committed` outcome of `txDigest` for `presaleId` and links the reservation's
   * Privy account when its embedded wallet is the event's sender. While the
   * node has not checkpointed the transaction (or cannot answer), it tries
   * again after each `pendingRetryDelaysMs`. Never throws; call it from
   * a reserved after-response job so the execute response never waits on it.
   */
  recordSponsoredCommit(
    input: Readonly<{ presaleId: string; txDigest: string; privyDid: string | null }>,
  ): Promise<PresaleOutcomeResult>;
}>;

/** A sponsored commit is tried at once, then after 1, 2 and 4 s while its transaction is pending. */
export const SPONSORED_COMMIT_RETRY_DELAYS_MS: readonly number[] =
  Object.freeze([1_000, 2_000, 4_000]);

// The DID shape `presale_embedded_wallets` and `presale_outcomes` accept.
const PRIVY_DID = /^did:privy:[A-Za-z0-9_-]{1,128}$/;
const METRIC = "presale.outcomes";

/**
 * The account's embedded Sui wallet (normalized), `null` without one, or
 * `undefined` when the lookup failed or ran past `timeoutMs` (a bounded
 * `outcome_privy` `dropped` metric). It never refuses the report.
 */
async function embeddedWalletOf(
  lookup: (privyDid: string) => Promise<string | null>,
  privyDid: string,
  timeoutMs: number,
): Promise<string | null | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const looking = Promise.resolve().then(() => lookup(privyDid));
    looking.catch(() => undefined);
    const wallet = await Promise.race([looking, deadline]);
    if (wallet === "timeout") {
      recordPresaleMetric(METRIC, {
        event: "outcome_privy",
        result: "dropped",
        reason: "timeout",
      });
      return undefined;
    }
    return wallet === null ? null : normalizeSuiAddress(wallet);
  } catch (error) {
    recordPresaleMetric(METRIC, {
      event: "outcome_privy",
      result: "dropped",
      reason: errorLabel(error),
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Records verified presale commit outcomes, as the launchpad does
 * (`docs/launchpad/telemetry.md`): the configured node verifies the sale's
 * `Committed` event; the outcome is its native sender's, with the chain's
 * checkpoint, time and position, whoever reports it; and the reporter's
 * Privy account is linked only when its embedded wallet is that sender (that
 * reporter's visitor too, when it has the cookie). The embedded wallet is
 * looked up alongside the node read, bounded by `identityTimeoutMs`, and
 * never refuses or delays a report past it. The store decides the visitor
 * link from on-time commitments (`PostgresPresaleOutcomeStore`).
 */
export function createPresaleOutcomeRecorder(
  dependencies: PresaleOutcomeRecorderDependencies,
): PresaleOutcomeRecorder {
  const identityTimeoutMs =
    dependencies.identityTimeoutMs ?? OUTCOME_PRIVY_TIMEOUT_MS;
  const retryDelays =
    dependencies.pendingRetryDelaysMs ?? SPONSORED_COMMIT_RETRY_DELAYS_MS;
  const sleep =
    dependencies.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function reporterLinked(
    privyDid: string | null,
    wallet: Promise<string | null | undefined>,
    senderWallet: string,
  ): Promise<boolean> {
    const sessionWallet = await wallet;
    const linked = privyDid !== null && sessionWallet === senderWallet;
    if (sessionWallet !== undefined && !linked) {
      recordPresaleMetric(METRIC, {
        event: "outcome_privy",
        result: "rejected",
        reason: sessionWallet === null ? "no-wallet" : "other-wallet",
      });
    }
    return linked;
  }

  async function record(
    input: PresaleOutcomeInput,
  ): Promise<PresaleOutcomeResult> {
    const { presaleId, txDigest, visitorId } = input;
    const privyDid = z.string().regex(PRIVY_DID).safeParse(input.privyDid).data ?? null;
    const wallet = privyDid
      ? embeddedWalletOf(
          dependencies.embeddedWallet,
          privyDid,
          identityTimeoutMs,
        )
      : Promise.resolve(undefined);
    const verdict = await dependencies.verify({ presaleId, txDigest });
    if (verdict.status !== "verified") {
      const result = verdict.status === "refused" ? "rejected" : "dropped";
      recordPresaleMetric(METRIC, {
        event: "outcome_report",
        result,
        reason: verdict.reason,
      });
      return verdict.status === "refused"
        ? { status: "not_found", reason: verdict.reason }
        : { status: "unavailable", reason: verdict.reason };
    }
    const linked = await reporterLinked(privyDid, wallet, verdict.senderWallet);
    const { result, late } = await dependencies.store.recordOutcome({
      presaleId,
      senderWallet: verdict.senderWallet,
      completion: verdict.completion,
      privyDid: linked ? privyDid : null,
      sessionVisitorId: linked ? visitorId : null,
    });
    if (late > 0)
      recordPresaleMetric(METRIC, {
        event: "outcome_commitment",
        result: "late",
        count: late,
      });
    return { status: result };
  }

  return Object.freeze({
    record,
    async recordSponsoredCommit({ presaleId, txDigest, privyDid }) {
      for (let attempt = 0; ; attempt += 1) {
        let outcome: PresaleOutcomeResult;
        try {
          outcome = await record({
            presaleId,
            txDigest,
            privyDid,
            visitorId: null,
          });
        } catch (error) {
          recordPresaleMetric(METRIC, {
            event: "sponsored_commit",
            result: "dropped",
            reason: errorLabel(error),
          });
          outcome = { status: "unavailable", reason: "storage-unavailable" };
        }
        const pending =
          outcome.status === "unavailable" ||
          (outcome.status === "not_found" &&
            (outcome.reason === "unknown-transaction" ||
              outcome.reason === "not-checkpointed"));
        if (!pending || attempt >= retryDelays.length) return outcome;
        await sleep(retryDelays[attempt]!);
      }
    },
  });
}
