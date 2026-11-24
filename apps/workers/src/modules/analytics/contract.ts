import { z } from "zod";

const integer = z.string().regex(/^(0|[1-9][0-9]*)$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const volume = z.strictObject({
  receipts: integer,
  priced_receipts: integer,
  priced_usd: decimal,
});

// The API publishes aggregates only. Integers and money never pass through Number.
// Account activity is unavailable until its separate, authorized collection exists.
export const aggregateSnapshot = z.strictObject({
  version: z.literal(2),
  volumeMethod: z.literal("registered-pool-quote-receipts-v1"),
  volumeUnit: z.literal("registered-pool-turnover-usd"),
  pricingPolicy: z.literal("historical-quote-oracle-60s-100bps-v1"),
  auditedTotalTradeVolumeUsd: decimal.nullable(),
  quoteTotals: z.record(z.string(), integer),
  asOfCheckpoint: integer,
  asOfTimestampMs: integer,
  windowEndExclusiveMs: integer,
  coverageStartCheckpoint: integer,
  coverageStartTimestampMs: integer.nullable(),
  historyScope: z.literal("since-configured-checkpoint"),
  catchingUp: z.boolean(),
  transactionScope: z.literal("selected-launch-presale-trade-facts"),
  users: z.strictObject({
    unit: z.literal("active-wallets"),
    dau24h: integer,
    mau30d: integer,
    uniqueSinceCoverage: integer,
    productDau: z.null(),
    productMau: z.null(),
  }),
  accountActivity: z.null(),
  totals: z.record(z.string(), z.strictObject({
    count: integer,
    pricedCount: integer,
    pricedUsd: decimal,
  })),
  volumeWindows: z.strictObject({ "24h": volume, "30d": volume }),
  dailyTradeVolume: z.array(volume.extend({ day_ms: integer })).max(30),
});

type AggregateSnapshot = z.infer<typeof aggregateSnapshot>;
export type Snapshot = Readonly<{ generated_at: Date; payload: AggregateSnapshot }>;

// These count collected, authenticated existing accounts, never people or registrations.
export const accountActivityReport = z.strictObject({
  unit: z.literal("authenticated-existing-accounts"),
  collectionStartedAt: z.string().datetime(),
  dau24h: integer,
  mau30d: integer,
  uniqueSinceCollection: integer,
  partial30d: z.boolean(),
  samplingIntervalMs: z.literal(900000),
  daily: z
    .array(z.strictObject({ day_ms: integer, accounts: integer }))
    .max(30),
});

// V2 remains strict and unchanged. V3 is stored, served and selected separately.
export const aggregateSnapshotV3 = aggregateSnapshot.extend({
  version: z.literal(3),
  chainPublicationTimestampMs: integer,
  accountObservationTimestampMs: integer,
  accountActivity: accountActivityReport.nullable(),
});
export type SnapshotV3 = Readonly<{
  generated_at: Date;
  payload: z.infer<typeof aggregateSnapshotV3>;
}>;
