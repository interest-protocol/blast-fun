// Unpaid positive daily allocations, attributed to immutable funding and actual native claim/close facts.
import { normalizeSuiAddress } from "@mysten/sui/utils";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { expectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";

export type WaitReason = "next" | "unpayable";

/** One unpaid allocation of one round, and why it waits. Amounts are atoms, as decimal strings. */
export type WaitingReward = Readonly<{
  /** The on-chain `Round`. */
  roundId: string;
  /** The round's number in its vault. */
  number: string;
  leafIndex: number;
  beneficiary: string;
  memeAmount: string;
  quoteAmount: string;
  reason: WaitReason;
  /** The indexed publication time in milliseconds for the next relay. */
  decidedAtMs: number;
  /** After this (ms) anyone may close the round; what is unpaid then returns to the vault. */
  claimDeadlineMs: number;
}>;

/** One vault's waiting allocations across its rounds, oldest round first. */
export type PresaleWaitingRewards = Readonly<{
  presaleId: string;
  vaultId?: string;
  memeType: string;
  quoteType: string;
  allocations: readonly WaitingReward[];
}>;

/** The most wallets one read takes. */
export const WAITING_WALLETS_MAX = 50;

type Row = {
  presale_id: string;
  vault_id: string;
  meme_type: string;
  quote_type: string;
  round_id: string;
  number: string;
  leaf_index: number;
  beneficiary: string;
  meme_amount: string;
  quote_amount: string;
  reason: WaitReason;
  decided_at: Date;
  claim_deadline_ms: string;
};

/**
 * The unpaid holder-reward allocations of `wallets` on `network` that wait on
 * the relay, grouped by vault (in order of first appearance: oldest round
 * first), each with its reason. Wallets are normalized; at most
 * `WAITING_WALLETS_MAX`. An empty list reads nothing.
 */
export async function waitingRewardsFor(
  db: ReadableDatabase,
  network: string,
  wallets: readonly string[],
): Promise<PresaleWaitingRewards[]> {
  const owners = [
    ...new Set(wallets.map((wallet) => normalizeSuiAddress(wallet))),
  ];
  if (owners.length === 0) return [];
  if (owners.length > WAITING_WALLETS_MAX)
    throw new RangeError(
      `At most ${WAITING_WALLETS_MAX} wallets are read at once.`,
    );
  const selection = expectedDeployment(process.env);
  if (!selection || selection.network !== network)
    throw new Error("Daily waiting reward deployment is unavailable.");
  const { rows } = await db.read<Row>(
    "SELECT * FROM vault_waiting_rewards($1,$2,$3::text[])",
    [selection.network, selection.deployment, owners],
  );
  const byVault = new Map<
    string,
    {
      presaleId: string;
      vaultId?: string;
      memeType: string;
      quoteType: string;
      allocations: WaitingReward[];
    }
  >();
  for (const row of rows) {
    const entry = byVault.get(row.vault_id) ?? {
      presaleId: row.presale_id,
      vaultId: row.vault_id,
      memeType: row.meme_type,
      quoteType: row.quote_type,
      allocations: [],
    };
    byVault.set(row.vault_id, entry);
    entry.allocations.push(
      Object.freeze({
        roundId: row.round_id,
        number: row.number,
        leafIndex: Number(row.leaf_index),
        beneficiary: row.beneficiary,
        memeAmount: row.meme_amount,
        quoteAmount: row.quote_amount,
        reason: row.reason,
        decidedAtMs: row.decided_at.getTime(),
        claimDeadlineMs: Number(row.claim_deadline_ms),
      }),
    );
  }
  return [...byVault.values()].map((entry) =>
    Object.freeze({ ...entry, allocations: Object.freeze(entry.allocations) }),
  );
}
