import { createSemaphore, type Semaphore } from "@blast/server/lib/concurrency.ts";
import type { Provenance } from "../../../../../core/src/modules/launchpad-contract/read.ts";
import type { Section } from "@blast/core/modules/launchpad-contract/section.ts";

/**
 * Fixture builders for the launchpad projection tickets' tests: the shared
 * provenance, section states, a blast-infra `/v1` summary with its inputs,
 * WebSocket frames with cursors, and the broken inputs every boundary must
 * refuse. Test-only; values follow blast-infra's docs/api.md examples.
 */

export const FIXTURE_NETWORK = "mainnet";
export const FIXTURE_FINGERPRINT = "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c";
export const FIXTURE_CHECKPOINT = 326_274_009;
export const FIXTURE_TIMESTAMP_MS = 1_790_235_061_218;

/** blast-infra's wire `provenance`, 412 ms behind by default. */
export function infraProvenanceFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    network: FIXTURE_NETWORK,
    deployment_fingerprint: FIXTURE_FINGERPRINT,
    checkpoint: FIXTURE_CHECKPOINT,
    timestamp_ms: FIXTURE_TIMESTAMP_MS,
    observed_ms: FIXTURE_TIMESTAMP_MS + 412,
    lag_ms: 412,
    ...overrides,
  };
}

/** A section's provenance: blast-infra, current, 412 ms behind by default. */
export function provenanceFixture(overrides: Partial<Provenance> = {}): Provenance {
  return {
    source: "blast-infra",
    network: FIXTURE_NETWORK,
    deployment: FIXTURE_FINGERPRINT,
    checkpoint: FIXTURE_CHECKPOINT,
    timestampMs: FIXTURE_TIMESTAMP_MS,
    observedAt: FIXTURE_TIMESTAMP_MS + 412,
    lagMs: 412,
    ...overrides,
  };
}

/** A replica whose committed checkpoint is `lagMs` old: the watermark-lag case. */
export function laggingProvenanceFixture(lagMs: number): Provenance {
  return provenanceFixture({
    source: "replica",
    timestampMs: FIXTURE_TIMESTAMP_MS + 412 - lagMs,
    lagMs,
    reason: "replica-lag",
  });
}

/** One section of `data` in each state: current, stale, empty and unavailable. */
export function sectionFixtures<T>(data: T): Readonly<{
  available: Section<T>;
  stale: Section<T>;
  empty: Section<T>;
  unavailable: Section<T>;
}> {
  return {
    available: { state: "available", data, provenance: provenanceFixture() },
    stale: {
      state: "stale",
      data,
      provenance: laggingProvenanceFixture(45_000),
      reason: "replica-lag",
    },
    empty: { state: "empty", provenance: provenanceFixture() },
    unavailable: { state: "unavailable", reason: "not_ready", retryAfterSeconds: 1 },
  };
}

/** The docs/api.md curve pool summary: price, market cap and supply with the inputs they come from. */
export function poolSummaryFixture(): Record<string, unknown> {
  return {
    pool_key: "blast_curve:0xa1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4",
    venue: "blast_curve",
    pool_id: "0xa1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4",
    coin: "0x3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c::froggy::FROGGY",
    quote: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
    lifecycle: "live",
    price: "0.002528735632183908045977011494252873",
    market_cap: "2528730574712",
    supply: "999998000000000",
    inputs: {
      virtual_quote: "1500000000000",
      meme_reserve: "696000000000000",
      quote_reserve: "260000000000",
      graduation_target: "3000000000000",
      sqrt_price_x64: null,
      meme_is_coin_a: null,
      currency_supply: "1000000000000000",
      pending_burn_total: "2000000000",
      balance_0x0: "0",
      meme_decimals: "6",
      quote_decimals: "9",
    },
  };
}

/**
 * The docs/api.md `GET /v1/pools?view=near_graduation` row: a live launch
 * curve with its identity, launch settings and launch facts (shared, named
 * partner admitted, not migrated).
 */
export function launchSummaryFixture(): Record<string, unknown> {
  const partnerId = "0x00000000000000000000000000000000000000000000000000000000000000bb";
  return {
    ...poolSummaryFixture(),
    metadata: { name: "Froggy", symbol: "FROGGY", description: "A frog.", icon_url: "https://example.com/froggy.png" },
    created_cursor: "325874009:1:2:0",
    created_at_ms: 1_790_200_000_000,
    launch: {
      venue: "0x0000000000000000000000000000000000000000000000000000000000000abc::cetus::Venue",
      pool_tier: {
        venue: "cetus",
        tick_spacing: "60",
        fee_rate: null,
        pool_creation_cap_id: "0x8181818181818181818181818181818181818181818181818181818181818181",
      },
      lp_fee_split: { routes: [
        { destination: { kind: "owner" }, bps: "5000" },
        { destination: { kind: "auto_lp" }, bps: "2000" },
        { destination: { kind: "holder_rewards" }, bps: "2000" },
        { destination: { kind: "burn" }, bps: "1000" },
      ] },
      allocation_plan: {
        curve_meme_bps: "8000", lp_meme_bps: "1900", lp_quote_bps: "9800",
        protocol_meme_bps: "100", protocol_quote_bps: "200", recipients: [],
      },
      opening_round_ms: "0",
      creation_fee: "1000000000",
      partner_id: partnerId,
      expected_vault_id: "0x54c6e6409b2bab7c1070cf9c384db4645149b7033ad08d8724eed0811ab26f5c",
    },
    public_start_ms: "1790200000000",
    partner: { partner_id: partnerId, status: "admitted", accepted_until_ms: null },
    migration: null,
  };
}

/** Atomic values a decimal-string boundary must refuse. */
export const INVALID_DECIMALS: readonly unknown[] = [12, 1.5, "", "-1", "01", "1e3", "1.0", " 1", null];

/** Page tokens a cursor boundary must refuse. */
export const INVALID_CURSORS: readonly string[] = ["", "not base64!", "e30", "A".repeat(600)];

/** A dependency bound with its only slot taken: the saturated-dependency case. Call `release` after. */
export async function saturatedDependency(): Promise<Readonly<{ slots: Semaphore; release: () => void }>> {
  const slots = createSemaphore(1);
  const release = await slots.acquire(0);
  return { slots, release };
}
