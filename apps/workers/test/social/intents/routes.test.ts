import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SOCIAL_ERRORS } from "@blast/core/modules/social/contracts/errors.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import {
  INTENT_EXPIRY_MS,
  INTENT_LATE_AFTER_MS,
  INTENT_REGISTER_TIMEOUT_MS,
  SOCIAL_INTENTS_PATH,
  SOCIAL_INTENT_ACTIONS,
  SOCIAL_INTENT_ROUTE,
  SOCIAL_INTENT_STATUSES,
  SOCIAL_INTENT_WHY_RESULTS,
  SOCIAL_TX_DIGEST_PATTERN,
} from "@blast/core/modules/social/contracts/intents.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { DEFAULT_RATE_POLICIES } from "@blast/core/lib/web-security/rate-limits.ts";
import { INTENT_INSERT_SQL, INTENT_OWNER_SQL } from "@blast/server/modules/social/intents/route.ts";
import { INTENT_STATEMENTS } from "#workers/modules/social/intents/resolve.ts";

/** Social feed T-024: the intents route as Next publishes it, its contract and its published codes. */

const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const PRESALE = `0x${"ab".repeat(32)}`;

test("T-024: the contract's path is the intents route", () => {
  assert.equal(SOCIAL_INTENTS_PATH, "/api/social/intents");
  assert.equal(SOCIAL_INTENT_ROUTE, "POST /api/social/intents");
});

test("T-024-AC-4 (AC-126): the route's bucket is the contract's `social_intent`, 60 a minute per account", () => {
  assert.deepEqual(DEFAULT_RATE_POLICIES.social_intent, {
    bucket: "social_intent",
    subjectScope: "account",
    version: 1,
    windows: [{ limit: 60, windowSeconds: 60 }],
  });
  // The route declares it, so the kit enforces it; nothing else registers it.
  assert.match(readFileSync(new URL("../../../../../packages/server/src/modules/social/intents/route.ts", import.meta.url), "utf8"), /bucket: "social_intent"/);
});

test("T-024-AC-2 (AC-095): `digest_taken` is a published 409 with no Retry-After and a fixed message", () => {
  assert.deepEqual(SOCIAL_ERRORS.digest_taken, { status: 409, retryAfter: false });
  const refusal = new SocialRouteError("digest_taken");
  assert.equal(refusal.status, 409);
  assert.equal(refusal.retryAfterSeconds, null);
  assert.deepEqual(refusal.body(), { error: { code: "digest_taken", message: "That transaction is already registered to another account." } });
});

test("T-024-AC-1 (AC-081): the published schemas are the route's body and its answer, closed", () => {
  const validator = createSocialValidator();
  const valid = (name: "intent-request" | "intent-response", body: unknown) => validator.validate(name, body).valid;
  const base = { action: "commit", presale_id: PRESALE, tx_digest: DIGEST };
  assert.ok(valid("intent-request", base));
  assert.ok(valid("intent-request", { ...base, source_entry_id: "a:12:0:0:0" }));
  assert.ok(valid("intent-request", { ...base, why: "Great team, real product." }));
  // The swap feature's actions are refused by the schema, as the route refuses them.
  assert.ok(!valid("intent-request", { ...base, action: "buy" }));
  assert.ok(!valid("intent-request", { ...base, action: "sell" }));
  assert.ok(!valid("intent-request", { ...base, presale_id: PRESALE.toUpperCase() }));
  assert.ok(!valid("intent-request", { ...base, tx_digest: "0OIl" }));
  assert.ok(!valid("intent-request", { ...base, extra: 1 }));
  assert.ok(!valid("intent-request", { action: "commit", presale_id: PRESALE }));
  // R3-27: the commit's transaction-log facts, optional; an amount names its coin.
  const USDC = `0x${"db".repeat(32)}::usdc::USDC`;
  assert.ok(valid("intent-request", { ...base, quote_type: USDC, quote_amount: "50000000", usd_value: "50.00" }));
  assert.ok(valid("intent-request", { ...base, quote_type: USDC }));
  assert.ok(valid("intent-request", { ...base, usd_value: "12.5" }));
  assert.ok(!valid("intent-request", { ...base, quote_amount: "50000000" }), "an amount without its coin");
  assert.ok(!valid("intent-request", { ...base, quote_type: "0x2::sui::SUI" }), "the SDK's normalised form only");
  assert.ok(!valid("intent-request", { ...base, quote_type: USDC, quote_amount: "-1" }));
  assert.ok(!valid("intent-request", { ...base, quote_type: USDC, quote_amount: "1.5" }));
  assert.ok(!valid("intent-request", { ...base, usd_value: "1.234" }));
  // The answer: a status and a why result, and nothing else — never the text.
  assert.ok(valid("intent-response", { status: "recorded", why: "accepted" }));
  assert.ok(valid("intent-response", { status: "recorded", why: null }));
  assert.ok(valid("intent-response", { status: "duplicate", why: null }));
  for (const result of SOCIAL_INTENT_WHY_RESULTS) assert.ok(valid("intent-response", { status: "recorded", why: result }), result);
  assert.ok(!valid("intent-response", { status: "recorded" }));
  assert.ok(!valid("intent-response", { status: "taken", why: null }));
  assert.ok(!valid("intent-response", { status: "recorded", why: "accepted", text: "x" }));
  // Every refusal the answer can name is a published social code, so a client
  // renders it with the copy it already has.
  for (const result of SOCIAL_INTENT_WHY_RESULTS) {
    if (result === "accepted") continue;
    assert.ok(result in SOCIAL_ERRORS, result);
  }
});

test("T-024: a digest is base58 as Sui writes one, and the actions and statuses are the column's", () => {
  assert.match(DIGEST, SOCIAL_TX_DIGEST_PATTERN);
  // 0, O, I and l are not in base58; 32 to 44 characters is the whole range.
  for (const bad of ["", "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl", `${DIGEST}xx`, DIGEST.slice(0, 31), "a".repeat(45), `${DIGEST}!`]) {
    assert.ok(!SOCIAL_TX_DIGEST_PATTERN.test(bad), bad);
  }
  // The column's CHECK allows all three actions and all four statuses; the
  // route accepts one action, and the worker writes three of the statuses.
  assert.deepEqual([...SOCIAL_INTENT_ACTIONS], ["commit", "buy", "sell"]);
  assert.deepEqual([...SOCIAL_INTENT_STATUSES], ["pending", "applied", "rejected_sender", "late"]);
  const migration = readFileSync(new URL("../../../../../packages/core/src/modules/database/migrations/0054_social_schema.up.sql", import.meta.url), "utf8");
  for (const action of SOCIAL_INTENT_ACTIONS) assert.ok(migration.includes(`'${action}'`), action);
  for (const status of SOCIAL_INTENT_STATUSES) assert.ok(migration.includes(`'${status}'`), status);
});

test("T-024-AC-1/AC-2: one digest has one row, so a retry writes nothing and an owner decides the answer", () => {
  // `ON CONFLICT DO NOTHING` on the primary key is what makes `recorded` /
  // `duplicate` / `digest_taken` three readings of one row.
  assert.match(INTENT_INSERT_SQL, /INSERT INTO social_intents/);
  assert.match(INTENT_INSERT_SQL, /ON CONFLICT \(tx_digest\) DO NOTHING/);
  assert.ok(!/why_text\s*=/.test(INTENT_INSERT_SQL), "a why is written once, never updated");
  assert.match(INTENT_OWNER_SQL, /WHERE tx_digest = \$1/);
  // The row starts pending: the column's default, not the route's business.
  assert.ok(!INTENT_INSERT_SQL.includes("status"), "the status is the column's default");
});

test("T-024-AC-3 (AC-096): the registration's ceiling is published, and so are the worker's two clocks", () => {
  assert.equal(INTENT_REGISTER_TIMEOUT_MS, 3_000);
  assert.equal(INTENT_LATE_AFTER_MS, 30_000);
  assert.equal(INTENT_EXPIRY_MS, 24 * 60 * 60 * 1_000);
});

test("T-024/T-026: no statement of either half reads a chain table or view the product does not publish", () => {
  // `assertChainReadThroughViews` runs at import time for the worker's
  // statements; this pins the route's too, and that the batch goes through
  // `chain_read_v1.activity` by digest rather than any blast-infra table.
  for (const sql of [INTENT_INSERT_SQL, INTENT_OWNER_SQL]) assert.ok(!/chain_read_v1|blast_infra/.test(sql), sql);
  assert.match(INTENT_STATEMENTS.batch, /JOIN chain_read_v1\.activity a ON a\.digest = i\.tx_digest/);
  assert.match(INTENT_STATEMENTS.batch, /a\.checkpoint <= \$1/);
  assert.match(INTENT_STATEMENTS.batch, /ORDER BY i\.registered_at, i\.tx_digest/);
  // T-020's rule: a reader of a sale goes through `SHOWN_PRESALES`, so the
  // source post's sale carries its guards (no sale decimals, an unlisted quote
  // or an unknown venue never reaches an attribution). The file itself never
  // names the view, which is what `scripts/social-shown-presales.test.ts`'s guard scans for.
  for (const sql of [INTENT_STATEMENTS.sourceActivity, INTENT_STATEMENTS.sourceLifecycle, INTENT_STATEMENTS.sourceMilestone]) {
    assert.match(sql, /sale_decimals IS NOT NULL AND quote_decimals IS NOT NULL AND quote_symbol IS NOT NULL AND venue IS NOT NULL/);
  }
  const resolveSource = readFileSync(new URL("../../../src/modules/social/intents/resolve.ts", import.meta.url), "utf8");
  assert.ok(!/(FROM|JOIN)\s+chain_read_v1\.presales\b/.test(resolveSource), "the step names SHOWN_PRESALES, never the view");
});

test("T-024-AC-4 (AC-130): the response refuses a why's text", () => {
  const validator = createSocialValidator();
  assert.equal(validator.validate("intent-response", { status: "recorded", why: "accepted" }).valid, true);
  assert.equal(validator.validate("intent-response", { status: "recorded", why: "accepted", text: "private-why-text" }).valid, false);
});
