import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { decodePresaleEvent, presaleEventModules } from "@interest-protocol/blast-sdk/presale";
import type { SuiClientTypes } from "@mysten/sui/client";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

import {
  createCompletedEventVerifier,
  type CompletedEventMatch,
  type CompletedEventSource,
  type CompletedEventVerdict,
} from "@blast/server/modules/launchpad-telemetry/outcomes.ts";
import {
  presaleNode,
  presaleNodeUrl,
} from "@blast/core/modules/presale/deployment/node.ts";
import type { PresaleDeploymentState } from "@blast/core/modules/presale/deployment/contracts.ts";

/** What a presale outcome report names: the sale and the transaction's digest. Nothing else comes from the client. */
export type PresaleOutcomeReport = Readonly<{
  presaleId: string;
  txDigest: string;
}>;

/** Why a transaction holds no `Committed` event of the sale. Bounded labels, safe in metrics; never input. */
export type PresaleCommitRefusal =
  | "foreign-lineage"
  | "other-presale"
  | "not-a-commit";

export type PresaleOutcomeVerdict = CompletedEventVerdict<PresaleCommitRefusal>;
export type PresaleOutcomeVerifier = (
  report: PresaleOutcomeReport,
) => Promise<PresaleOutcomeVerdict>;

/** Whether `eventType` is a presale `Committed` of another package. */
function foreignCommitted(
  eventType: string,
  originalPackageId: string,
): boolean {
  try {
    const tag = parseStructTag(eventType);
    return (
      tag.module === presaleEventModules.Committed &&
      tag.name === "Committed" &&
      tag.address !== normalizeSuiAddress(originalPackageId)
    );
  } catch {
    return false;
  }
}

/**
 * The sale's first `Committed` event of the configured presale lineage in the
 * transaction, decoded with the SDK's `decodePresaleEvent`, or why there is
 * none: another sale's commit, a look-alike from another package, or no commit.
 */
function matchCommitted(
  report: PresaleOutcomeReport,
  transaction: SuiClientTypes.Transaction<{ events: true }>,
  originalPackageId: string,
  checkpoint: string,
): CompletedEventMatch<PresaleCommitRefusal> {
  let foreign = false;
  let otherPresale = false;
  for (const [eventIndex, entry] of transaction.events.entries()) {
    let decoded;
    try {
      const position = {
        checkpoint,
        transactionDigest: report.txDigest,
        eventIndex,
      };
      decoded = decodePresaleEvent(
        { ...entry, ...position },
        { originalPackageId },
      );
    } catch {
      foreign ||= foreignCommitted(entry.eventType, originalPackageId);
      continue;
    }
    if (decoded.kind !== "Committed") continue;
    if (normalizeSuiAddress(decoded.payload.presale_id) === report.presaleId)
      return { eventIndex };
    otherPresale = true;
  }
  return {
    reason: otherPresale
      ? "other-presale"
      : foreign
        ? "foreign-lineage"
        : "not-a-commit",
  };
}

/**
 * Verifies a presale outcome report on the configured node (`source`, null
 * when none) with the launchpad's bounded read (`createCompletedEventVerifier`:
 * 2 s, 8 reads in flight per process, the node's chain checked once). The
 * transaction must have executed, be in a checkpoint, and hold a `Committed`
 * of the configured presale package for `presaleId`; the outcome is the
 * event's native sender's, with the chain's checkpoint, time and position. A
 * pending transaction is refused at once, never waited for. Never throws.
 */
export function createPresaleOutcomeVerifier(
  source: () => Promise<CompletedEventSource | null>,
  options: Readonly<{
    timeoutMs?: number;
    maxConcurrent?: number;
    trackWork?: <T>(promise: Promise<T>) => Promise<T>;
  }> = {},
): PresaleOutcomeVerifier {
  return createCompletedEventVerifier({
    configured: source,
    source: (configured: CompletedEventSource) => configured,
    match: matchCommitted,
    ...options,
  });
}

/**
 * The node the verifier reads: the presale deployment identity's (`state`)
 * node (`presaleNodeUrl` over `nodeUrl`, the process's mainnet node), its chain
 * identifier and its presale package lineage. The chain identifier is read the
 * way the identity gate reads it (`presaleNode`: fresh and abortable). Null
 * without an identity or an allowed node; every report is then
 * `service_unavailable`. Build it once per process: the verifier checks a node's
 * chain once.
 */
export function presaleOutcomeSource(
  state: PresaleDeploymentState,
  nodeUrl: string,
): CompletedEventSource | null {
  const baseUrl = presaleNodeUrl(state, nodeUrl);
  const identityNode = presaleNode(state, nodeUrl);
  if (state.status !== "ready" || !baseUrl || !identityNode) return null;
  const grpc = new SuiGrpcClient({
    network: state.identity.network,
    baseUrl,
    format: "text",
    fetch: boundedFetch(8000),
  });
  return Object.freeze({
    client: Object.freeze({
      core: Object.freeze({
        getChainIdentifier: (options: Readonly<{ signal?: AbortSignal }>) =>
          identityNode.core.getChainIdentifier(options),
        getTransaction: (
          options: Readonly<{
            digest: string;
            include: Readonly<{ events: true }>;
            signal?: AbortSignal;
          }>,
        ) => grpc.core.getTransaction(options),
      }),
    }),
    chainIdentifier: state.identity.chainIdentifier,
    originalPackageId: normalizeSuiAddress(
      state.identity.presale.originalPackageId,
    ),
  });
}
