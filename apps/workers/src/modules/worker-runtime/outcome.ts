// What the node says one digest did. Every site that asks "did our
// transaction land?" reads it here, then makes its own decision from the
// answers: the effects say executed or failed, the node has no such
// transaction, it answered without effects, it answered with another
// transaction, it answered with this transaction but effects of another digest
// (a node fault: never read as ours), or it could not answer at all.

import { TransactionError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";

import type { Provider } from "./provider.ts";

type Include = SuiClientTypes.TransactionInclude & { effects: true };

export type DigestOutcome<Options extends Include> =
  /** The effects of exactly this digest, successful. */
  | Readonly<{ kind: "executed"; transaction: SuiClientTypes.Transaction<Options> }>
  /** The effects of exactly this digest, failed. */
  | Readonly<{ kind: "failed"; transaction: SuiClientTypes.Transaction<Options> }>
  /** The node's own answer that it has no such transaction. */
  | Readonly<{ kind: "not-found" }>
  /** The node answered with no effects. */
  | Readonly<{ kind: "no-effects" }>
  /** The node answered with a transaction of another digest. */
  | Readonly<{ kind: "other-transaction" }>
  /** The node answered with this transaction but effects naming another digest: a node fault. */
  | Readonly<{ kind: "other-effects" }>
  /** The lookup failed or ran out of time (`error`, a `ProviderUnavailable` from a bounded provider). */
  | Readonly<{ kind: "unknown"; error: unknown }>;

/**
 * Reads `digest` through `provider` with `include` (effects always). The
 * answer is executed or failed only when both the transaction and its effects
 * name `digest`.
 */
export async function readDigestOutcome<Options extends Include>(
  client: ClientWithCoreApi,
  provider: Provider,
  digest: string,
  include: Options,
): Promise<DigestOutcome<Options>> {
  let answer: SuiClientTypes.TransactionResult<Options> | null;
  try {
    answer = await provider(async (signal) => {
      try {
        return await client.core.getTransaction({ digest, include, signal });
      } catch (error) {
        if (error instanceof TransactionError && error.reason === "notFound") {
          return null;
        }
        throw error;
      }
    });
  } catch (error) {
    return { kind: "unknown", error };
  }
  if (!answer) {
    return { kind: "not-found" };
  }
  const transaction = answer.Transaction ?? answer.FailedTransaction;
  if (!transaction?.effects) {
    return { kind: "no-effects" };
  }
  if (transaction.digest !== digest) {
    return { kind: "other-transaction" };
  }
  if (transaction.effects.transactionDigest !== digest) {
    return { kind: "other-effects" };
  }
  return transaction.effects.status.success ? { kind: "executed", transaction } : { kind: "failed", transaction };
}
