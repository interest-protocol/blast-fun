import { decodeLaunchObject } from "@interest-protocol/blast-sdk/launchpad";
import { parseCoinSummary, parseVenuePool } from "@blast/core/modules/launchpad-contract/coin.ts";
import type { LaunchLifecycle } from "@blast/core/modules/launchpad-contract/discovery.ts";
import { executionAvailability } from "@blast/core/modules/launchpad-coin/availability.ts";
import type { CoinPage } from "@blast/core/modules/launchpad-coin/contracts.ts";
import type { FreshLaunch } from "@blast/core/modules/launchpad-coin/fresh-types.ts";
import { parseCurveBody } from "@blast/core/modules/launchpad-coin/market-sections.ts";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";
import {
  COIN_FIXTURE, CURVE_POOL_KEY, VENUE_POOL_KEY, coinBody, curvePoolBody,
  launchObjectFixture, venuePoolBody,
} from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";

const NOW = 1_790_235_061_630;
const provenance: Provenance = {
  source: "blast-infra", network: "localnet", deployment: "fixture", checkpoint: 326274009,
  timestampMs: NOW, observedAt: NOW, lagMs: 0,
};

export function coinScreenFixture(lifecycle: LaunchLifecycle = "migrated"): CoinPage {
  const fresh: FreshLaunch = {
    status: "read", launch: decodeLaunchObject(launchObjectFixture(lifecycle)), readAtMs: NOW,
    route: { venue: "bluefin", tickSpacing: 60, feeRate: 3000n, supported: true, reason: null },
  };
  const migrated = lifecycle === "migrated";
  return {
    launchId: COIN_FIXTURE.launchId,
    confirmed: true,
    tradable: lifecycle === "live" || migrated,
    fresh,
    conflict: null,
    source: migrated ? { kind: "venue", venue: "bluefin", poolKey: VENUE_POOL_KEY } : { kind: "curve", poolKey: CURVE_POOL_KEY },
    availability: executionAvailability({ fresh, coinType: COIN_FIXTURE.coinType, venue: migrated ? { poolKey: VENUE_POOL_KEY } : null }),
    curve: { state: "available", data: parseCurveBody(curvePoolBody(lifecycle, NOW), COIN_FIXTURE.launchId), provenance },
    coin: { state: "available", data: parseCoinSummary(coinBody(lifecycle, NOW), COIN_FIXTURE.coinType), provenance },
    venue: migrated ? { state: "available", data: parseVenuePool(venuePoolBody(NOW), VENUE_POOL_KEY, COIN_FIXTURE.coinType), provenance } : null,
  };
}
