// The coin fixture's native holder snapshot as blast-infra's
// `GET /v1/coins/{coin_type}/holders?view=snapshot` serves it (schema
// holders_snapshot), for tests and the dev fixture server only. Thirty
// addresses hold the Froggy coin. Some of their balances came from transfers
// and allocations that no trade records, so a count inferred from trades would
// be wrong; the snapshot's facts come from balances alone. The creator holds
// too, and no row carries a label.

import { decodeCursor, encodeCursor } from "../../../../src/modules/launchpad-contract/cursor.ts";
import { holdersCursor } from "@blast/core/modules/launchpad-contract/holders.ts";
import { COIN_FIXTURE, wireProvenance } from "./fixtures.ts";

/** What the fixture engine holds for the coin's holders. */
export const HOLDER_FIXTURE_STATES = ["complete", "incomplete", "behind", "zero"] as const;
export type HolderFixtureState = (typeof HOLDER_FIXTURE_STATES)[number];

/** The checkpoint every snapshot but `behind` is read at: the fixture provenance's. */
export const HOLDER_FIXTURE_CHECKPOINT = 326_274_009;
/** A `behind` snapshot's checkpoint: older than the engine's committed one. */
export const HOLDER_BEHIND_CHECKPOINT = 326_273_890;

const address = (index: number) => `0x${(index + 0x10).toString(16).repeat(32)}`;

/** Balance descending, then address ascending; two holders tie on balance. */
export const FIXTURE_HOLDERS: readonly Readonly<{ address: string; balance: bigint }>[] = [
  { address: COIN_FIXTURE.creator, balance: 120_000_000_000n },
  ...Array.from({ length: 29 }, (_, index) => ({
    address: address(index),
    balance: index === 4 ? 9_000_007_000n : BigInt(30 - index) * 1_000_000_000n + 7_000n,
  })),
].sort((left, right) =>
  left.balance === right.balance ? (left.address < right.address ? -1 : 1) : left.balance > right.balance ? -1 : 1,
);

const pad = (balance: bigint) => balance.toString().padStart(20, "0");
const share = (amount: bigint, held: bigint) => ((amount * 10_000n) / held).toString();

/**
 * One snapshot page after `cursor` (a page token of the fixture launch's
 * holders), `limit` rows; `state` decides completeness. The checkpoint stamp
 * matches the provenance except when the snapshot is `behind`.
 */
export function holderSnapshotBody(
  state: HolderFixtureState,
  request: Readonly<{ cursor?: string | null; limit?: number }>,
  now: number,
  lagMs?: number,
): Record<string, unknown> {
  const provenance = wireProvenance(now, lagMs);
  const checkpoint = state === "behind" ? HOLDER_BEHIND_CHECKPOINT : HOLDER_FIXTURE_CHECKPOINT;
  const snapshot = { state: state === "zero" ? "complete" : state, checkpoint, timestamp_ms: provenance.timestamp_ms };
  const base = { provenance, coin: COIN_FIXTURE.coinType, snapshot };
  if (state === "incomplete") {
    return { ...base, holder_count: null, held_supply: null, top_1: null, top_10: null, holders: null, next_cursor: null };
  }
  if (state === "zero") {
    return {
      ...base,
      holder_count: "0",
      held_supply: "0",
      top_1: { amount: "0", share_bps: null },
      top_10: { amount: "0", share_bps: null },
      holders: [],
      next_cursor: null,
    };
  }
  const shape = holdersCursor(COIN_FIXTURE.launchId);
  const held = FIXTURE_HOLDERS.reduce((sum, holder) => sum + holder.balance, 0n);
  const top10 = FIXTURE_HOLDERS.slice(0, 10).reduce((sum, holder) => sum + holder.balance, 0n);
  const after = request.cursor ? decodeCursor(request.cursor, shape).tie.join("|") : null;
  const place = after === null ? -1 : FIXTURE_HOLDERS.findIndex((holder) => `${pad(holder.balance)}|${holder.address}` === after);
  if (after !== null && place < 0) throw new Error("the cursor is no place in the fixture holders");
  const start = place + 1;
  const rows = FIXTURE_HOLDERS.slice(start, start + (request.limit ?? 25));
  const last = rows.at(-1);
  const more = last !== undefined && start + rows.length < FIXTURE_HOLDERS.length;
  return {
    ...base,
    holder_count: String(FIXTURE_HOLDERS.length),
    held_supply: held.toString(),
    top_1: { amount: FIXTURE_HOLDERS[0].balance.toString(), share_bps: share(FIXTURE_HOLDERS[0].balance, held) },
    top_10: { amount: top10.toString(), share_bps: share(top10, held) },
    holders: rows.map((row) => ({ address: row.address, balance: row.balance.toString(), share_bps: share(row.balance, held) })),
    next_cursor: more ? encodeCursor(shape, [], [pad(last.balance), last.address]) : null,
  };
}
