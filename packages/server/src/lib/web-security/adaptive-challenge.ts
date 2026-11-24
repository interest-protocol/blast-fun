import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { autocommitWrite } from "@blast/core/modules/database/transaction.ts";
import { WebSecurityError } from "@blast/core/lib/web-security/errors.ts";
import type { RateBucket } from "@blast/core/lib/web-security/rate-limits.ts";

export const ADAPTIVE_CHALLENGE_POLICY_VERSION = 1;

export type AdaptiveDecision =
  | "ordinary"
  | "challenge_required"
  | "challenge_passed"
  | "challenge_failed";

export interface AdaptiveDecisionAudit {
  decision: AdaptiveDecision;
  bucket: RateBucket;
  policyVersion: 1;
  reason: "normal_pattern" | "abnormal_failures";
  occurredAt: string;
}

export interface AdaptiveDecisionAuditSink {
  record(decision: AdaptiveDecisionAudit): Promise<void>;
}

export interface BotChallengeVerifier {
  verify(input: { action: "web-abuse"; token: string }): Promise<boolean>;
}

export interface AdaptiveChallengeInput {
  bucket: RateBucket;
  recentFailures: number;
  challengeToken?: string;
}

const FAILURE_THRESHOLDS: Partial<Record<RateBucket, number>> = {
  code: 4,
  wallet: 3,
  recovery: 3,
  oauth: 3,
};

export class AdaptiveChallengeController {
  readonly #audit: AdaptiveDecisionAuditSink;
  readonly #clock: () => Date;
  readonly #verifier: BotChallengeVerifier;

  constructor(input: {
    audit: AdaptiveDecisionAuditSink;
    verifier: BotChallengeVerifier;
    clock?: () => Date;
  }) {
    this.#audit = input.audit;
    this.#verifier = input.verifier;
    this.#clock = input.clock ?? (() => new Date());
  }

  async enforce(input: AdaptiveChallengeInput): Promise<void> {
    if (
      !Number.isSafeInteger(input.recentFailures) ||
      input.recentFailures < 0
    ) {
      throw new TypeError("Invalid adaptive risk signal.");
    }
    const threshold = FAILURE_THRESHOLDS[input.bucket];
    if (threshold === undefined || input.recentFailures < threshold) {
      await this.#record(input.bucket, "ordinary", "normal_pattern");
      return;
    }
    if (!input.challengeToken) {
      await this.#record(
        input.bucket,
        "challenge_required",
        "abnormal_failures",
      );
      throw new WebSecurityError("BOT_CHALLENGE_REQUIRED");
    }

    let valid = false;
    try {
      valid = await this.#verifier.verify({
        action: "web-abuse",
        token: input.challengeToken,
      });
    } catch {
      valid = false;
    }
    await this.#record(
      input.bucket,
      valid ? "challenge_passed" : "challenge_failed",
      "abnormal_failures",
    );
    if (!valid) throw new WebSecurityError("BOT_CHALLENGE_FAILED");
  }

  async #record(
    bucket: RateBucket,
    decision: AdaptiveDecision,
    reason: AdaptiveDecisionAudit["reason"],
  ): Promise<void> {
    await this.#audit.record({
      bucket,
      decision,
      occurredAt: this.#clock().toISOString(),
      policyVersion: ADAPTIVE_CHALLENGE_POLICY_VERSION,
      reason,
    });
  }
}

/**
 * Each decision is one append-only row with a fresh id, complete on its own,
 * so it is written as one autocommit statement: one round trip instead of a
 * transaction's three. A failed write still rejects `enforce`, as before.
 */
export class PostgresAdaptiveDecisionAuditSink
  implements AdaptiveDecisionAuditSink
{
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async record(decision: AdaptiveDecisionAudit): Promise<void> {
    await autocommitWrite(
      this.#pool,
      "web-security",
      "mission_control_abuse_decision_audit",
      `INSERT INTO mission_control_abuse_decision_audit (
         decision_id, policy_version, bucket, decision, reason, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        decision.policyVersion,
        decision.bucket,
        decision.decision,
        decision.reason,
        decision.occurredAt,
      ],
    );
  }
}
