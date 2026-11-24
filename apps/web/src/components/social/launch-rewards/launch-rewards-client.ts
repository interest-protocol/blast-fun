import {
  CursorError,
  readCreatorClaims,
  readWalletHolderRewards,
  readWalletLaunchRewards,
  type HolderPayout,
  type PendingCreatorClaim,
  type RoutedRead,
  type V1Answer,
  type WalletLaunchReward,
} from "#web/modules/launchpad-contract/browser-rewards.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";

/** One page of a wallet's list, or why it could not be read. */
export type RewardsPage<Row> = Readonly<{ kind: "rows"; rows: readonly Row[]; next: string | null }> | Readonly<{ kind: "failed"; reason: string }>;

async function page<T, Row>(
  read: () => Promise<RoutedRead<V1Answer<T>>>,
  rows: (value: T) => Readonly<{ rows: readonly Row[]; next: string | null }>,
): Promise<RewardsPage<Row>> {
  try {
    const answer = await read();
    if (answer.status === "unavailable") return { kind: "failed", reason: answer.provenance.reason ?? "unavailable" };
    if (answer.data.kind === "refused") return { kind: "failed", reason: answer.data.error.code };
    return { kind: "rows", ...rows(answer.data.value) };
  } catch (error) {
    if (error instanceof CursorError) return { kind: "failed", reason: "invalid_parameter" };
    return { kind: "failed", reason: "unreachable" };
  }
}

/**
 * The launches whose creator fees `address` can claim, a page after `cursor`: blast-infra's
 * `/v1/wallets/{address}/launch-rewards`, relayed by this app's private `/api/launchpad/market`
 * route and validated in the browser.
 */
export function readLaunchFeesPage(address: string, cursor: string | null, dependencies: MarketDataDependencies): Promise<RewardsPage<WalletLaunchReward>> {
  return page(() => readWalletLaunchRewards(address, { cursor }, dependencies), (value) => ({ rows: value.launches, next: value.nextCursor }));
}

/** The holder-reward payouts `address` received, a page after `cursor`, the same way. */
export function readHolderPayoutsPage(address: string, cursor: string | null, dependencies: MarketDataDependencies): Promise<RewardsPage<HolderPayout>> {
  return page(() => readWalletHolderRewards(address, { cursor }, dependencies), (value) => ({ rows: value.payouts, next: value.nextCursor }));
}

/**
 * The launches whose creator rights the Blast wallet `address` can still claim, a page after
 * `cursor`: blast-infra's `/v1/creator-claims?recipient=`, relayed and validated the same way.
 */
export function readWalletCreatorClaimsPage(address: string, cursor: string | null, dependencies: MarketDataDependencies): Promise<RewardsPage<PendingCreatorClaim>> {
  return page(() => readCreatorClaims({ kind: "address", address }, { cursor }, dependencies), (value) => ({ rows: value.launches, next: value.nextCursor }));
}

/** The launches naming the account's creator `commitment` (`/v1/creator-claims?account=`), the same way. */
export function readAccountCreatorClaimsPage(commitment: string, cursor: string | null, dependencies: MarketDataDependencies): Promise<RewardsPage<PendingCreatorClaim>> {
  return page(() => readCreatorClaims({ kind: "account", commitment }, { cursor }, dependencies), (value) => ({ rows: value.launches, next: value.nextCursor }));
}
