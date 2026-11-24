// The coin fixture's fees as blast-infra serves them (`GET /v1/launches/{launch_id}/rewards`,
// schema launch_rewards), for tests and the dev fixture server only. Before migration the vault
// is null; after it the curve's ledger stands as it closed and the vault carries on. The launch
// names a partner, so both ledgers show the partner's paid amounts.

import type { LaunchLifecycle } from "../../../../src/modules/launchpad-contract/discovery.ts";
import { COIN_FIXTURE, curvePoolSummary, wireProvenance } from "./fixtures.ts";

export const FIXTURE_PARTNER = `0x${"bb".repeat(32)}`;

const share = (accrued: bigint, claimed: bigint) => ({
  accrued: String(accrued),
  claimed: String(claimed),
  outstanding: String(accrued - claimed),
});

const fixtureVaultId = `0x${"c1".repeat(32)}`;
const zeroPair = { meme: "0", quote: "0" };

function ledger(kind: "launch" | "vault", originId: string, amounts: readonly [bigint, bigint, bigint], settled: boolean) {
  const [meme, quote, sui] = amounts;
  const paid = (amount: bigint) => settled ? amount / 10n : 0n;
  const treasury = (amount: bigint) => settled ? amount - paid(amount) : 0n;
  const held = (amount: bigint) => settled ? 0n : amount;
  const triple = (map: (amount: bigint) => bigint) => ({ meme: String(map(meme)), quote: String(map(quote)), sui: String(map(sui)) });
  return {
    origin_id: originId,
    kind,
    package_witness: `${fixtureVaultId}::package::PackageWitness`,
    partner_id: FIXTURE_PARTNER,
    accrued: triple((amount) => amount),
    treasury_paid: triple(treasury),
    partner_paid: triple(paid),
    held: triple(held),
  };
}

/** The launch's fees at `lifecycle`. */
export function launchRewardsBody(lifecycle: LaunchLifecycle, now: number, lagMs?: number): Record<string, unknown> {
  const migrated = lifecycle === "migrated";
  const protocol = ledger("launch", COIN_FIXTURE.launchId, [7_000_000_000n, migrated ? 245_000_000n : 205_000_000n, 2_000_000_000n], migrated);
  return {
    provenance: wireProvenance(now, lagMs),
    launch_id: COIN_FIXTURE.launchId,
    coin: COIN_FIXTURE.coinType,
    quote: COIN_FIXTURE.quoteType,
    creator: {
      meme: share(14_000_000_000n, migrated ? 4_200_000_000n : 0n),
      quote: share(410_000_000n, migrated ? 61_000_000n : 0n),
      sui: share(0n, 0n),
    },
    protocol,
    partner: { partner_id: FIXTURE_PARTNER, paid: migrated ? protocol.partner_paid : null },
    allocations: migrated
      ? [{ cursor: "326100000:2:3:0", destination: `0x${"d1".repeat(32)}`, meme: "8000000000000", quote: "0", meme_vesting_id: null, quote_vesting_id: null }]
      : [],
    expected_vault_id: fixtureVaultId,
    vault: migrated
      ? {
          vault_id: fixtureVaultId,
          origin: { kind: "launch", id: COIN_FIXTURE.launchId },
          collected: { gross: { meme: "1000000000", quote: "500000000" }, protocol: { meme: "100000000", quote: "50000000" } },
          owner: { accrued: { meme: "450000000", quote: "225000000" }, claimed: { meme: "400000000", quote: "200000000" } },
          auto_lp: { accrued: { meme: "90000000", quote: "45000000" }, added: { meme: "80000000", quote: "40000000" }, pending: { meme: "10000000", quote: "5000000" } },
          holder_rewards: { accrued: { meme: "270000000", quote: "135000000" }, published: { meme: "200000000", quote: "100000000" }, returned: zeroPair },
          burn: { accrued: { meme: "90000000", quote: "45000000" }, meme_burned: "30000000", quote_spent: "40000000", quote_pending: "5000000" },
          address: zeroPair,
          protocol_fees: ledger("vault", fixtureVaultId, [100_000_000n, 50_000_000n, 0n], true),
        }
      : null,
    quote_usd: null,
  };
}

/** A wallet's launch rewards (`GET /v1/wallets/{address}/launch-rewards`): the coin fixture's launch, at `lifecycle`. */
export function walletLaunchRewardsBody(address: string, lifecycle: LaunchLifecycle, now: number): Record<string, unknown> {
  const migrated = lifecycle === "migrated";
  const curve = { meme: share(14_000_000_000n, migrated ? 4_200_000_000n : 0n), quote: share(410_000_000n, migrated ? 61_000_000n : 0n) };
  const vault = migrated ? { meme: share(450_000_000n, 400_000_000n), quote: share(225_000_000n, 200_000_000n) } : null;
  const outstanding = (coin: "meme" | "quote") =>
    String(BigInt(curve[coin].outstanding) + (vault ? BigInt(vault[coin].outstanding) : 0n));
  return {
    provenance: wireProvenance(now),
    address,
    launches: [
      {
        launch_id: COIN_FIXTURE.launchId,
        coin: COIN_FIXTURE.coinType,
        quote: COIN_FIXTURE.quoteType,
        lifecycle,
        metadata: { name: "Froggy", symbol: "FROGGY", description: "A frog.", icon_url: "https://example.com/froggy.png" },
        meme_decimals: "6",
        quote_decimals: "9",
        creator: COIN_FIXTURE.creator,
        entitled_by: "curve_fee_cap",
        curve,
        vault,
        outstanding: { meme: outstanding("meme"), quote: outstanding("quote") },
      },
    ],
    next_cursor: null,
  };
}

/** A wallet's vault reward payouts, newest first. */
export function walletHolderRewardsBody(address: string, now: number): Record<string, unknown> {
  const payout = (position: string, round: number, meme: string, quote: string) => ({
    origin: { kind: "launch", id: COIN_FIXTURE.launchId },
    meme: COIN_FIXTURE.coinType,
    quote: COIN_FIXTURE.quoteType,
    vault_id: fixtureVaultId,
    round_id: `0x${String(90 + round).repeat(32)}`,
    round_number: String(round),
    index: "2",
    amount: { meme, quote },
    timestamp_ms: 1_790_170_000_000 + round,
    digest: "9Xy3K7mQpR2sT4uV6wX8yZ1aB3cD5eF7gH9jK2mN4pQ",
    relayed_by: address,
    cursor: position,
  });
  return {
    provenance: wireProvenance(now),
    wallet: address,
    payouts: [payout("326200000:4:2:0", 1, "40000000", "20000000"), payout("326150000:4:2:0", 0, "15000000", "25000000")],
    next_cursor: null,
  };
}

/**
 * A launch row of `GET /v1/creator-claims`: the fixture curve's discovery row, as `launchId`
 * created at `createdCursor` (another launch of the same coin shape when it is not the fixture's).
 */
export function pendingCreatorClaimRow(
  launchId: string = COIN_FIXTURE.launchId,
  createdCursor = "325874009:1:2:0",
  lifecycle: LaunchLifecycle = "live",
): Record<string, unknown> {
  return { ...curvePoolSummary(lifecycle), pool_key: `blast_curve:${launchId}`, pool_id: launchId, created_cursor: createdCursor };
}

/** A recipient's pending creator claims (`GET /v1/creator-claims`), newest first by creation. */
export function creatorClaimsBody(
  recipient: Readonly<{ kind: "address"; address: string }> | Readonly<{ kind: "account"; commitment: string }>,
  now: number,
  launches: readonly Record<string, unknown>[] = [pendingCreatorClaimRow()],
  nextCursor: string | null = null,
): Record<string, unknown> {
  return {
    provenance: wireProvenance(now),
    recipient_kind: recipient.kind,
    recipient: recipient.kind === "address" ? recipient.address : recipient.commitment,
    launches,
    next_cursor: nextCursor,
  };
}
