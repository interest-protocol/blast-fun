// Fixture transactions for presale outcome registration: completed `Committed`
// transactions of the fixture presale identity, and every case that must not
// record (another presale, another package, no commit, failed, pending,
// unknown). The launchpad's outcome fixture node serves them. They serve
// tests only, never real value.

import { presaleEventBcs, presaleEventModules } from "@interest-protocol/blast-sdk/presale";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiAddress, toBase58 } from "@mysten/sui/utils";

import {
  createOutcomeFixtureNode,
  type OutcomeFixtureNode,
  type OutcomeFixtureNodeState,
  type OutcomeFixtureTransaction,
} from "../../../../../../core/test/fixtures/modules/launchpad-telemetry/outcome-fixtures.ts";
import type { CompletedEventSource } from "@blast/server/modules/launchpad-telemetry/outcomes.ts";
import { SUI_MAINNET_CHAIN_IDENTIFIER, presaleIdentityFixture } from "../../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";

const PACKAGE = normalizeSuiAddress((presaleIdentityFixture().presale as { originalPackageId: string }).originalPackageId);
const FOREIGN_PACKAGE = normalizeSuiAddress(`0x${"f1".repeat(32)}`);
const MEME = `${normalizeSuiAddress(`0x${"e1".repeat(32)}`)}::meme::MEME`;
const QUOTE = `${normalizeSuiAddress(`0x${"e2".repeat(32)}`)}::usdc::USDC`;

function digest(seed: number): string {
  return toBase58(new Uint8Array(32).fill(seed));
}

export const PRESALE_OUTCOME_FIXTURE = Object.freeze({
  presaleId: normalizeSuiAddress(`0x${"7a".repeat(32)}`),
  otherPresaleId: normalizeSuiAddress(`0x${"7b".repeat(32)}`),
  packageId: PACKAGE,
  chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER,
  checkpoint: 412_000_101,
  timestampMs: 1_791_000_456_000,
  senders: Object.freeze({
    /** A wallet that commits from its own wallet (Slush). */
    committer: normalizeSuiAddress(`0x${"d1".repeat(32)}`),
    /** A Privy embedded wallet whose commit was sponsored. */
    embedded: normalizeSuiAddress(`0x${"d2".repeat(32)}`),
  }),
  digests: Object.freeze({
    /** A swap's coin event, then the presale's `Committed` at event 1. */
    commit: digest(41),
    /** A sponsored commit by the embedded wallet: `Committed` at event 0. */
    sponsored: digest(42),
    /** Another presale's `Committed`. */
    otherPresale: digest(43),
    /** A `Committed` for this presale ID from another package. */
    foreign: digest(44),
    /** The presale's `PresaleOpened`, no commit. */
    notACommit: digest(45),
    failed: digest(46),
    /** A completed commit the node has not put in a checkpoint yet. */
    pending: digest(47),
    /** No node has it. */
    unknown: digest(48),
    /** A second commit by the committer, for link and contest cases. */
    secondCommit: digest(49),
  }),
});

function presaleEvent(
  kind: "Committed" | "PresaleOpened",
  bcs: Uint8Array,
  packageId: string = PACKAGE,
): SuiClientTypes.Event {
  return {
    packageId,
    module: "blast_presale",
    sender: PRESALE_OUTCOME_FIXTURE.senders.committer,
    eventType: `${packageId}::${presaleEventModules[kind]}::${kind}<${MEME}, ${QUOTE}>`,
    bcs,
    json: null,
  };
}

function committed(presaleId: string, packageId?: string): SuiClientTypes.Event {
  const payload = presaleEventBcs.Committed.serialize({
    presale_id: presaleId,
    quote: 250_000_000n,
    wallet_commitment: 250_000_000n,
    total_commitments: 9_250_000_000n,
    participants: 12n,
  });
  return presaleEvent("Committed", payload.toBytes(), packageId);
}

function opened(presaleId: string): SuiClientTypes.Event {
  const payload = presaleEventBcs.PresaleOpened.serialize({
    presale_id: presaleId,
    start_ms: 1_791_000_000_000n,
    end_ms: 1_791_086_400_000n,
    liquidity_deadline_ms: 1_791_172_800_000n,
    uncapped_from_ms: 1_791_043_200_000n,
    // ADR 0110: no sale-level hard cap here.
    hard_cap_from_ms: null,
    partner_id: null,
  });
  return presaleEvent("PresaleOpened", payload.toBytes());
}

function swapEvent(): SuiClientTypes.Event {
  return { packageId: "0x2", module: "coin", sender: PRESALE_OUTCOME_FIXTURE.senders.committer, eventType: "0x2::coin::CoinCreated", bcs: new Uint8Array([1]), json: null };
}

/** A transaction `sender` signed: every event it emits carries that sender, as on Sui. */
export function landedPresaleTransaction(
  digestValue: string,
  events: readonly SuiClientTypes.Event[],
  overrides: Partial<OutcomeFixtureTransaction> = {},
  sender: string = PRESALE_OUTCOME_FIXTURE.senders.committer,
): OutcomeFixtureTransaction {
  return {
    digest: digestValue,
    success: true,
    checkpoint: String(PRESALE_OUTCOME_FIXTURE.checkpoint),
    timestampMs: PRESALE_OUTCOME_FIXTURE.timestampMs,
    events: events.map((entry) => ({ ...entry, sender })),
    ...overrides,
  };
}

/** Every presale fixture transaction by digest; `unknown` is deliberately absent. */
export function presaleOutcomeTransactions(): Map<string, OutcomeFixtureTransaction> {
  const { presaleId, otherPresaleId, digests, senders } = PRESALE_OUTCOME_FIXTURE;
  return new Map(
    [
      landedPresaleTransaction(digests.commit, [swapEvent(), committed(presaleId)]),
      landedPresaleTransaction(digests.secondCommit, [committed(presaleId)]),
      landedPresaleTransaction(digests.sponsored, [committed(presaleId)], {}, senders.embedded),
      landedPresaleTransaction(digests.otherPresale, [committed(otherPresaleId)]),
      landedPresaleTransaction(digests.foreign, [committed(presaleId, FOREIGN_PACKAGE)]),
      landedPresaleTransaction(digests.notACommit, [opened(presaleId)]),
      landedPresaleTransaction(digests.failed, [], { success: false }),
      landedPresaleTransaction(digests.pending, [committed(presaleId)], { checkpoint: null, timestampMs: null }),
    ].map((transaction) => [transaction.digest, transaction]),
  );
}

/** The launchpad's outcome fixture node on the presale fixture chain, serving the presale transactions. */
export function createPresaleOutcomeFixtureNode(
  overrides: Partial<OutcomeFixtureNodeState> = {},
  transactions: Map<string, OutcomeFixtureTransaction> = presaleOutcomeTransactions(),
): OutcomeFixtureNode & { source: CompletedEventSource; transactions: Map<string, OutcomeFixtureTransaction> } {
  const node = createOutcomeFixtureNode({ chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER, ...overrides }, transactions);
  return {
    ...node,
    transactions,
    source: { client: node.client, chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER, originalPackageId: PACKAGE },
  };
}
