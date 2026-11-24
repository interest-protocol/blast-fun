import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "@blast/core/lib/web-security/mutation-guard.ts";
import {
  createPool,
  migrateDatabase,
} from "@blast/core/modules/database/admin.ts";
import {
  MemberSessionError,
  MemberSessionService,
} from "@blast/server/modules/mission-control/member-sessions/index.ts";
import {
  WalletChallengeError,
  WalletChallengeService,
  type IssuedWalletChallenge,
} from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import {
  syntheticEmbeddedSigner,
  syntheticSlushSigner,
} from "../../../../../core/test/fixtures/modules/mission-control/wallet-challenges/testing.ts";
import { CrewAccessError } from "@blast/server/modules/mission-control/crew-access/errors.ts";
import { CrewAccessService } from "@blast/server/modules/mission-control/crew-access/service.ts";
import { installRuntimeConfig } from "../../../../test/fixtures/config/runtime-config.ts";

// The default wallet verifier reads its node URL from the API runtime config.
installRuntimeConfig();

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const ORIGIN = "https://blast.fun";
const CSRF = "c".repeat(43);
const START = new Date("2026-09-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function mutationRequest(cookie = ""): Request {
  return new Request(`${ORIGIN}/api/mission-control/restore`, {
    method: "POST",
    headers: {
      Cookie: [cookie.split(";", 1)[0], `${CSRF_COOKIE_NAME}=${CSRF}`]
        .filter(Boolean)
        .join("; "),
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      [CSRF_HEADER_NAME]: CSRF,
    },
  });
}

async function seedCompletedProfile(
  pool: Pool,
  input: {
    index: number;
    privyDid: string;
    address: string;
    walletKind: "embedded" | "slush";
  },
) {
  const suffix = String(input.index).padStart(12, "0");
  const profileId = `10000000-0000-4000-8000-${suffix}`;
  const membershipId = `20000000-0000-4000-8000-${suffix}`;
  const allocationId = `30000000-0000-4000-8000-${suffix}`;
  const cardId = `40000000-0000-4000-8000-${suffix}`;
  await pool.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, sui_address,
       provider_wallet_reference, callsign, disclosure_version,
       disclosure_accepted_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'season-zero-v1', $7, $7)`,
    [
      profileId,
      input.privyDid,
      `x-crew-access-${input.index}`,
      input.address,
      `wallet-crew-access-${input.index}`,
      `recovery_${input.index}`,
      START,
    ],
  );
  await pool.query(
    `INSERT INTO mission_control_account_identities (
       profile_id, provider, provider_subject, verified_at
     ) VALUES ($1, 'x', $2, $4), ($1, 'privy', $3, $4)`,
    [profileId, `x-crew-access-${input.index}`, input.privyDid, START],
  );
  await pool.query(
    `INSERT INTO mission_control_account_wallets (
       wallet_id, profile_id, wallet_kind, sui_address,
       provider_wallet_reference, is_primary, verified_at
     ) VALUES ($1, $1, $2, $3, $4, TRUE, $5)`,
    [
      profileId,
      input.walletKind,
      input.address,
      `wallet-crew-access-${input.index}`,
      START,
    ],
  );
  await pool.query(
    `INSERT INTO mission_control_season_memberships (
       membership_id, allocation_id, card_id, season_id, profile_id,
       crew_number, fleet, foundry_launch_method, owner_title,
       zero_fleet, gold, created_at
     ) VALUES ($1, $2, $3, 'season-zero', $4, $5, 'Recon', NULL,
       'Zero Fleet Commando', TRUE, TRUE, $6)`,
    [membershipId, allocationId, cardId, profileId, input.index, START],
  );
  await pool.query(
    `INSERT INTO mission_control_invitation_allocations (
       allocation_id, profile_id, membership_id, policy_version,
       code_count, created_at
     ) VALUES ($1, $2, $3, 'season-zero-v3', 0, $4)`,
    [allocationId, profileId, membershipId, START],
  );
  await pool.query(
    `INSERT INTO mission_control_cards (
       card_id, profile_id, membership_id, record_schema, record_version,
       card_record, render_status, created_at
     ) VALUES ($1, $2, $3, 'blast.season-zero-card', 3, '{}', 'pending', $4)`,
    [cardId, profileId, membershipId, START],
  );
  return profileId;
}

function verificationRequest(
  challenge: IssuedWalletChallenge,
  signature: string,
) {
  return {
    action: challenge.action,
    address: challenge.address,
    challengeId: challenge.challengeId,
    context: challenge.context,
    message: challenge.message,
    origin: challenge.origin,
    signature,
  };
}

test(
  "completed embedded and Slush owners restore one opaque session; replay, absence, expiry, and revocation fail closed",
  {
    skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set",
  },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 6 });
    let now = new Date(START);
    let token = 0;
    const sessions = new MemberSessionService({
      clock: () => new Date(now),
      pool,
      tokenFactory: () => String.fromCharCode(97 + token++).repeat(43),
    });
    const access = new CrewAccessService({
      pool,
      sessions,
    });
    let challengeId = 1;
    let nonce = 1;
    const challenges = new WalletChallengeService(pool, {
      clock: () => new Date(now),
      createId: () =>
        `50000000-0000-4000-8000-${String(challengeId++).padStart(12, "0")}`,
      createNonce: () => Buffer.alloc(32, nonce++).toString("base64url"),
      rateLimiter: {
        async consume() {
          return { allowed: true, retryAfterSeconds: 0 };
        },
      },
    });
    const rateSubject = { ip: "203.0.113.10", address: "crew-access" };

    try {
      const migrations = await migrateDatabase(pool);
      assert.ok(migrations.includes("0009_atomic_completion"));
      const embeddedProfileId = await seedCompletedProfile(pool, {
        address: syntheticEmbeddedSigner.toSuiAddress(),
        index: 1,
        privyDid: "did:privy:crew-access-embedded",
        walletKind: "embedded",
      });
      const slushProfileId = await seedCompletedProfile(pool, {
        address: syntheticSlushSigner.toSuiAddress(),
        index: 2,
        privyDid: "did:privy:crew-access-slush",
        walletKind: "slush",
      });

      async function restore(
        signer: typeof syntheticEmbeddedSigner | typeof syntheticSlushSigner,
        privyDid: string | null,
      ) {
        const issued = await challenges.issue(
          {
            action: "restore_crew_access",
            address: signer.toSuiAddress(),
            context: { kind: "recovery", id: `recovery-${challengeId}` },
            origin: ORIGIN,
          },
          rateSubject,
        );
        const signed = await signer.signPersonalMessage(
          new TextEncoder().encode(issued.message),
        );
        const proof = await challenges.verify(
          verificationRequest(issued, signed.signature),
          rateSubject,
        );
        let cookie = "";
        const restored = await access.restore({
          expectedOrigin: ORIGIN,
          privyDid,
          proof,
          request: mutationRequest(),
          setCookie: (value) => {
            cookie = value;
          },
        });
        return { cookie, issued, restored, signature: signed.signature };
      }

      const embedded = await restore(
        syntheticEmbeddedSigner,
        "did:privy:crew-access-embedded",
      );
      assert.equal(embedded.restored.profileId, embeddedProfileId);
      assert.match(embedded.cookie, /HttpOnly; Secure; SameSite=Lax/);
      assert.equal(
        (await access.resume(mutationRequest(embedded.cookie))).profileId,
        embeddedProfileId,
      );
      await assert.rejects(
        challenges.verify(
          verificationRequest(embedded.issued, embedded.signature),
          rateSubject,
        ),
        (error) =>
          error instanceof WalletChallengeError &&
          error.code === "WALLET_PROOF_INVALID",
      );

      const slush = await restore(syntheticSlushSigner, null);
      assert.equal(slush.restored.profileId, slushProfileId);
      assert.equal(
        (await access.resume(mutationRequest(slush.cookie))).profileId,
        slushProfileId,
      );

      const absolute = await restore(
        syntheticEmbeddedSigner,
        "did:privy:crew-access-embedded",
      );
      for (const day of [6, 12, 18, 24, 29]) {
        now = new Date(START.getTime() + day * DAY_MS);
        assert.equal(
          (await access.resume(mutationRequest(absolute.cookie))).profileId,
          embeddedProfileId,
        );
      }
      now = new Date(START.getTime() + 30 * DAY_MS);
      await assert.rejects(
        access.resume(mutationRequest(absolute.cookie)),
        (error) =>
          error instanceof MemberSessionError &&
          error.code === "SESSION_INVALID",
      );
      now = new Date(START);

      const sessionCount = Number(
        (
          await pool.query(
            "SELECT COUNT(*)::int AS count FROM mission_control_member_sessions",
          )
        ).rows[0]?.count,
      );
      const absentIssued = await challenges.issue(
        {
          action: "restore_crew_access",
          address: syntheticEmbeddedSigner.toSuiAddress(),
          context: { kind: "recovery", id: "absent-privy" },
          origin: ORIGIN,
        },
        rateSubject,
      );
      const absentSigned = await syntheticEmbeddedSigner.signPersonalMessage(
        new TextEncoder().encode(absentIssued.message),
      );
      const absentProof = await challenges.verify(
        verificationRequest(absentIssued, absentSigned.signature),
        rateSubject,
      );
      await assert.rejects(
        access.restore({
          expectedOrigin: ORIGIN,
          privyDid: "did:privy:not-the-owner",
          proof: absentProof,
          request: mutationRequest(),
          setCookie: () =>
            assert.fail("absent owner must not receive a session"),
        }),
        (error) =>
          error instanceof CrewAccessError &&
          error.code === "CREW_ACCESS_DENIED",
      );
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT COUNT(*)::int AS count FROM mission_control_member_sessions",
            )
          ).rows[0]?.count,
        ),
        sessionCount,
      );

      now = new Date(START.getTime() + 7 * DAY_MS);
      await assert.rejects(
        access.resume(mutationRequest(embedded.cookie)),
        (error) =>
          error instanceof MemberSessionError &&
          error.code === "SESSION_INVALID",
      );
      now = new Date(START);
      assert.equal(await sessions.revoke(mutationRequest(slush.cookie)), true);
      await assert.rejects(
        access.resume(mutationRequest(slush.cookie)),
        (error) =>
          error instanceof MemberSessionError &&
          error.code === "SESSION_INVALID",
      );
    } finally {
      await pool.end();
    }
  },
);
