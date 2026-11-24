import type { CompletedEvent } from "@blast/core/modules/launchpad-telemetry/contracts.ts";

/** A visitor's commitment of a transaction's digest, sent before submission, with the server's receipt time. */
export type PresaleCommitment = Readonly<{
  presaleId: string;
  txDigest: string;
  /** The first-party opaque visitor (`__Host-blast_vid`). */
  visitorId: string;
  committedAt: Date;
}>;

/**
 * A verified `Committed` outcome to record. Everything but the two proven
 * links comes from the chain: the sender, the checkpoint, the time and the
 * event's position.
 */
export type PresaleOutcomeRecord = Readonly<{
  presaleId: string;
  /** The `Committed` event's native sender, normalized. */
  senderWallet: string;
  completion: CompletedEvent;
  /** The Privy account whose embedded wallet is the sender, or null. */
  privyDid: string | null;
  /** The visitor that reported with that Privy session, or null. */
  sessionVisitorId: string | null;
}>;

export type PresaleRecordResult = "recorded" | "duplicate";

/** The presale outcome storage (`PostgresPresaleOutcomeStore`). Failures propagate. */
export interface PresaleOutcomeStore {
  /** Stores `(digest, visitor)` once; the first receipt is kept. */
  recordCommitment(commitment: PresaleCommitment): Promise<PresaleRecordResult>;
  /**
   * Records the outcome once per completed event and decides its links; `late`
   * counts the digest's commitments received at or after its checkpoint time.
   */
  recordOutcome(
    outcome: PresaleOutcomeRecord,
  ): Promise<Readonly<{ result: PresaleRecordResult; late: number }>>;
}
