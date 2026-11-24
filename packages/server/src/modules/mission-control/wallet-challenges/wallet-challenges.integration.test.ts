import assert from "node:assert/strict";
import test from "node:test";

import {
  migrateDatabase,
  resetDatabase,
} from "@blast/core/modules/database/admin.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import {
  WalletChallengeError,
  WalletChallengeService,
  type IssuedWalletChallenge,
} from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import type { WalletChallengeRateLimiter } from "@blast/core/lib/web-security/rate-limits.ts";
import {
  syntheticEmbeddedSigner,
  syntheticSlushSigner,
} from "../../../../../core/test/fixtures/modules/mission-control/wallet-challenges/testing.ts";
import { installRuntimeConfig } from "../../../../test/fixtures/config/runtime-config.ts";

// The default wallet verifier reads its node URL from the API runtime config.
installRuntimeConfig();

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const baseTime = new Date("2026-09-20T12:00:00.000Z");

class TestRateLimiter implements WalletChallengeRateLimiter {
  allow = true;
  readonly calls: Array<Parameters<WalletChallengeRateLimiter["consume"]>[0]> = [];

  async consume(
    input: Parameters<WalletChallengeRateLimiter["consume"]>[0],
  ): Promise<Readonly<{ allowed: boolean; retryAfterSeconds: number }>> {
    this.calls.push(input);
    return { allowed: this.allow, retryAfterSeconds: this.allow ? 0 : 600 };
  }
}

function verificationRequest(
  challenge: IssuedWalletChallenge,
  signature: string,
) {
  return {
    challengeId: challenge.challengeId,
    action: challenge.action,
    address: challenge.address,
    origin: challenge.origin,
    context: challenge.context,
    message: challenge.message,
    signature,
  };
}

test(
  "wallet challenges verify exact Sui personal messages once without domain mutation",
  { skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 4 });
    const limiter = new TestRateLimiter();
    let now = new Date(baseTime);
    let id = 1;
    let nonceByte = 1;
    const service = new WalletChallengeService(pool, {
      rateLimiter: limiter,
      clock: () => new Date(now),
      createId: () => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
      createNonce: () => Buffer.alloc(32, nonceByte++).toString("base64url"),
    });
    const rateSubject = { ip: "test-client", address: "test-address" };

    async function issueFor(
      signer: typeof syntheticSlushSigner | typeof syntheticEmbeddedSigner,
      action: "onboarding" | "restore_crew_access" = "onboarding",
    ) {
      return service.issue(
        {
          action,
          address: signer.toSuiAddress(),
          origin: "https://blast.fun",
          context:
            action === "onboarding"
              ? { kind: "attempt", id: `attempt-${id}` }
              : { kind: "recovery", id: `recovery-${id}` },
        },
        rateSubject,
      );
    }

    async function assertInvalid(operation: Promise<unknown>) {
      await assert.rejects(operation, (error: unknown) => {
        assert.ok(error instanceof WalletChallengeError);
        assert.equal(error.code, "WALLET_PROOF_INVALID");
        assert.equal(error.message, "Wallet verification failed.");
        return true;
      });
    }

    try {
      const appliedMigrations = await migrateDatabase(pool);
      assert.deepEqual(appliedMigrations.slice(0, 2), [
        "0001_mission_control_foundation",
        "0002_wallet_challenges",
      ]);

      const challenge = await issueFor(syntheticSlushSigner);
      assert.equal(
        new Date(challenge.expiresAt).getTime() -
          new Date(challenge.issuedAt).getTime(),
        5 * 60 * 1_000,
      );
      const signed = await syntheticSlushSigner.signPersonalMessage(
        new TextEncoder().encode(challenge.message),
      );
      const proof = await service.verify(
        verificationRequest(challenge, signed.signature),
        rateSubject,
      );
      assert.deepEqual(proof, {
        proofType: "sui_personal_message",
        challengeId: challenge.challengeId,
        action: "onboarding",
        address: syntheticSlushSigner.toSuiAddress(),
        origin: "https://blast.fun",
        context: challenge.context,
        verifiedAt: baseTime.toISOString(),
      });
      await assertInvalid(
        service.verify(verificationRequest(challenge, signed.signature), rateSubject),
      );

      const alterations: Array<
        (request: ReturnType<typeof verificationRequest>) =>
          ReturnType<typeof verificationRequest>
      > = [
        (request) => ({ ...request, action: "restore_crew_access" }),
        (request) => ({ ...request, origin: "https://www.blast.fun" }),
        (request) => ({
          ...request,
          address: syntheticEmbeddedSigner.toSuiAddress(),
        }),
        (request) => ({
          ...request,
          context: { kind: "attempt", id: "different-attempt" },
        }),
        (request) => ({ ...request, message: `${request.message}!` }),
      ];

      for (const alter of alterations) {
        const candidate = await issueFor(syntheticSlushSigner);
        const candidateSignature = await syntheticSlushSigner.signPersonalMessage(
          new TextEncoder().encode(candidate.message),
        );
        await assertInvalid(
          service.verify(
            alter(verificationRequest(candidate, candidateSignature.signature)),
            rateSubject,
          ),
        );
      }

      const wrongSignerChallenge = await issueFor(syntheticSlushSigner);
      const wrongSignature = await syntheticEmbeddedSigner.signPersonalMessage(
        new TextEncoder().encode(wrongSignerChallenge.message),
      );
      await assertInvalid(
        service.verify(
          verificationRequest(wrongSignerChallenge, wrongSignature.signature),
          rateSubject,
        ),
      );

      const expired = await issueFor(syntheticSlushSigner);
      const expiredSignature = await syntheticSlushSigner.signPersonalMessage(
        new TextEncoder().encode(expired.message),
      );
      now = new Date(baseTime.getTime() + 5 * 60 * 1_000);
      await assertInvalid(
        service.verify(
          verificationRequest(expired, expiredSignature.signature),
          rateSubject,
        ),
      );
      now = new Date(baseTime);

      const recovery = await issueFor(
        syntheticEmbeddedSigner,
        "restore_crew_access",
      );
      const recoverySignature = await syntheticEmbeddedSigner.signPersonalMessage(
        new TextEncoder().encode(recovery.message),
      );
      assert.equal(
        (
          await service.verify(
            verificationRequest(recovery, recoverySignature.signature),
            rateSubject,
          )
        ).action,
        "restore_crew_access",
      );

      const beforeDenied = await pool.query(
        "SELECT COUNT(*)::int AS count FROM mission_control_wallet_challenges",
      );
      limiter.allow = false;
      await assert.rejects(
        issueFor(syntheticSlushSigner),
        (error: unknown) =>
          error instanceof WalletChallengeError &&
          error.code === "WALLET_CHALLENGE_RATE_LIMITED" &&
          error.retryAfterSeconds === 600,
      );
      const afterDenied = await pool.query(
        "SELECT COUNT(*)::int AS count FROM mission_control_wallet_challenges",
      );
      assert.equal(afterDenied.rows[0].count, beforeDenied.rows[0].count);

      const persisted = await pool.query(
        `SELECT nonce_hash, message_hash, consumed_at
         FROM mission_control_wallet_challenges
         ORDER BY challenge_id`,
      );
      assert.ok(persisted.rows.length >= 9);
      assert.ok(
        persisted.rows.every(
          (row) =>
            /^[0-9a-f]{64}$/.test(row.nonce_hash) &&
            /^[0-9a-f]{64}$/.test(row.message_hash),
        ),
      );
      assert.doesNotMatch(JSON.stringify(persisted.rows), /Nonce:|BLAST\.FUN/);

      const campaignEvents = await pool.query(
        "SELECT COUNT(*)::int AS count FROM mission_control_campaign_events",
      );
      assert.equal(campaignEvents.rows[0].count, 0);

      assert.deepEqual(await resetDatabase(pool), appliedMigrations);
    } finally {
      await pool.end();
    }
  },
);
