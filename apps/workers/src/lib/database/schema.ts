import { MIGRATOR_VENUES } from "@blast/core/modules/launchpad-contract/venues.ts";
import { sql } from "drizzle-orm";
import { bigint, customType, integer, jsonb, numeric, pgSchema, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Query models only: existing SQL migrations own constraints, indexes and grants.
export const workerLeases = pgTable("mission_control_worker_leases", {
  job: text().notNull(),
  leaseKey: text("lease_key").notNull(),
  holder: uuid().notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const workerJobs = pgTable("mission_control_worker_jobs", {
  job: text().notNull(),
  network: text().notNull(),
  cursor: jsonb(),
  blockedReasons: text("blocked_reasons").array(),
  blockedAt: timestamp("blocked_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
export const workerSubmissions = pgTable("mission_control_worker_submissions", {
  digest: text().notNull(),
  signerAddress: text("signer_address").notNull(),
  network: text().notNull(),
  job: text().notNull(),
  recordKeys: text("record_keys").array().notNull(),
  intent: jsonb().notNull(),
  transactionBytes: bytea("transaction_bytes").notNull(),
  expiresEpoch: numeric("expires_epoch", { precision: 20, scale: 0 }).notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolution: text({ enum: ["executed", "failed", "expired"] }),
});

export const registrations = pgTable("mission_control_coin_registrations", {
  network: text().notNull(),
  memeType: text("meme_type").notNull(),
  createdCheckpoint: bigint("created_checkpoint", { mode: "bigint" }).notNull(),
  pendingCurrencyId: text("pending_currency_id"),
  pendingCurrencyVersion: text("pending_currency_version"),
  pendingCurrencyDigest: text("pending_currency_digest"),
  publicationDigest: text("publication_digest"),
  ticketId: text("ticket_id"),
  state: text({ enum: ["pending", "submitted", "registered", "rejected", "stalled"] }).notNull(),
  attempts: integer().notNull().default(0),
  latestDigest: text("latest_digest"),
  nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }).notNull(),
  errorClass: text("error_class"),
  outcome: text({ enum: ["registered-by-worker", "already-registered"] }),
  sharedCurrencyId: text("shared_currency_id"),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  registeredAt: timestamp("registered_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const migrations = pgTable("mission_control_launch_migrations", {
  network: text().notNull(),
  launchId: text("launch_id").notNull(),
  memeType: text("meme_type").notNull(),
  quoteType: text("quote_type").notNull(),
  readyCheckpoint: bigint("ready_checkpoint", { mode: "bigint" }).notNull(),
  venue: text({ enum: MIGRATOR_VENUES }),
  state: text({ enum: ["pending", "submitted", "blocked", "migrated", "rejected", "stalled"] }).notNull(),
  attempts: integer().notNull().default(0),
  latestDigest: text("latest_digest"),
  digests: text().array().notNull().default(sql`'{}'::text[]`),
  nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }).notNull(),
  errorClass: text("error_class"),
  outcome: text({ enum: ["migrated-by-worker", "already-migrated"] }),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  migratedAt: timestamp("migrated_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const openingRounds = pgTable("mission_control_opening_rounds", {
  network: text().notNull(),
  launchId: text("launch_id").notNull(),
  memeType: text("meme_type").notNull(),
  quoteType: text("quote_type").notNull(),
  createdCheckpoint: bigint("created_checkpoint", { mode: "bigint" }).notNull(),
  state: text({ enum: ["pending", "settling", "delivering", "delivered", "no-round", "rejected", "stalled"] }).notNull(),
  roundEndMs: bigint("round_end_ms", { mode: "bigint" }),
  settledBy: text("settled_by", { enum: ["worker", "external"] }),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  biddersCursor: text("bidders_cursor"),
  deliveredBidders: integer("delivered_bidders").notNull().default(0),
  attempts: integer().notNull().default(0),
  latestDigest: text("latest_digest"),
  settleDigests: text("settle_digests").array().notNull().default(sql`'{}'::text[]`),
  nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }).notNull(),
  errorClass: text("error_class"),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const feeClaims = pgTable("mission_control_fee_claims", {
  network: text().notNull(),
  launchId: text("launch_id").notNull(),
  memeType: text("meme_type").notNull(),
  quoteType: text("quote_type").notNull(),
  createdCheckpoint: bigint("created_checkpoint", { mode: "bigint" }).notNull(),
  state: text({ enum: ["active", "complete", "rejected", "stalled"] }).notNull(),
  partnerId: text("partner_id"),
  vaultId: text("vault_id"),
  attempts: integer().notNull().default(0),
  latestDigest: text("latest_digest"),
  curveClaims: integer("curve_claims").notNull().default(0),
  vaultClaims: integer("vault_claims").notNull().default(0),
  lastClaimedAt: timestamp("last_claimed_at", { withTimezone: true }),
  nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }).notNull(),
  errorClass: text("error_class"),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const workerAlerts = pgTable("blast_worker_alerts", {
  alertKey: text("alert_key").notNull(),
  conditionSince: timestamp("condition_since", { withTimezone: true }).notNull(),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const chainWatermark = pgSchema("chain_read_v1").table("watermark", {
  network: text().notNull(),
  deploymentFingerprint: text("deployment_fingerprint").notNull(),
  checkpoint: bigint({ mode: "bigint" }),
});

export const socialDefaults = pgTable("social_default_accounts", {
  accountId: uuid("account_id").notNull(),
});
