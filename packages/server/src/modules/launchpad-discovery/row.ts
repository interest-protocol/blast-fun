import {
  launchProgressBps,
  quoteRemaining,
  type LaunchSummary,
} from "@blast/core/modules/launchpad-contract/discovery.ts";
import type { DiscoveryRow } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { TEST_SUI_COIN_TYPES } from "@blast/core/modules/social/contracts/create.ts";

export function isPublicLaunch(launch: LaunchSummary): boolean {
  return !TEST_SUI_COIN_TYPES.includes(launch.coinType) && !TEST_SUI_COIN_TYPES.includes(launch.quoteType);
}

/** A launch as a display row: blast-infra's facts, progress from the SDK over its raw inputs. */
export function discoveryRow(launch: LaunchSummary): DiscoveryRow {
  const { quoteReserve, graduationTarget, quoteDecimals } =
    launch.economics.inputs;
  const progressing =
    quoteReserve !== null && graduationTarget !== null && graduationTarget > 0n;
  return {
    launchId: launch.launchId,
    coinType: launch.coinType,
    quoteType: launch.quoteType,
    lifecycle: launch.lifecycle,
    name: launch.metadata?.name ?? null,
    symbol: launch.metadata?.symbol ?? null,
    iconUrl: launch.metadata?.iconUrl ?? null,
    createdAtMs: launch.createdAtMs,
    graduatedAtMs: launch.migration?.timestampMs ?? null,
    quoteRemaining: progressing
      ? quoteRemaining(quoteReserve, graduationTarget).toString()
      : null,
    quoteDecimals: quoteDecimals === null ? null : Number(quoteDecimals),
    progressBps: progressing ? Number(launchProgressBps(launch)) : null,
    partner: launch.partner
      ? { partnerId: launch.partner.partnerId, status: launch.partner.status }
      : null,
  };
}
