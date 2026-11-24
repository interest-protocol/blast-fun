import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import {
  createPool,
  migrateDatabase,
  resetDatabase,
} from "@blast/core/modules/database/admin.ts";
import { AccountLinksError } from "@blast/server/modules/mission-control/account-links/errors.ts";
import { AccountLinksService } from "@blast/server/modules/mission-control/account-links/service.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const NOW = new Date("2026-09-21T12:00:00.000Z");
const ACCOUNT_A = "a1000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "b1000000-0000-4000-8000-000000000002";
const ACCOUNT_C = "c1000000-0000-4000-8000-000000000003";
const ACCOUNT_D = "d1000000-0000-4000-8000-000000000004";
const EMBEDDED_A = `0x${"11".repeat(32)}`;
const SLUSH_A = `0x${"22".repeat(32)}`;
const SLUSH_B = `0x${"33".repeat(32)}`;
const EMBEDDED_B = `0x${"44".repeat(32)}`;

async function seedAccount(
  pool: Pool,
  input: Readonly<{
    profileId: string;
    callsign: string;
    xSubject: string;
    address: string;
    kind: "embedded" | "slush";
    privySubject?: string;
  }>,
) {
  const legacyPrivy = input.privySubject ?? `did:privy:legacy-${input.callsign}`;
  const providerReference = input.kind === "embedded"
    ? `privy:${input.profileId}`
    : `slush:${input.profileId}`;
  await pool.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, sui_address,
       provider_wallet_reference, callsign, disclosure_version,
       disclosure_accepted_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'season-zero-v1', $7, $7)`,
    [
      input.profileId,
      legacyPrivy,
      input.xSubject,
      input.address,
      providerReference,
      input.callsign,
      NOW,
    ],
  );
  await pool.query(
    `INSERT INTO mission_control_account_identities (
       profile_id, provider, provider_subject, verified_at
     ) VALUES ($1, 'x', $2, $3)`,
    [input.profileId, input.xSubject, NOW],
  );
  if (input.privySubject) {
    await pool.query(
      `INSERT INTO mission_control_account_identities (
         profile_id, provider, provider_subject, verified_at
       ) VALUES ($1, 'privy', $2, $3)`,
      [input.profileId, input.privySubject, NOW],
    );
  }
  await pool.query(
    `INSERT INTO mission_control_account_wallets (
       wallet_id, profile_id, wallet_kind, sui_address,
       provider_wallet_reference, is_primary, verified_at
     ) VALUES ($1, $1, $2, $3, $4, TRUE, $5)`,
    [input.profileId, input.kind, input.address, providerReference, NOW],
  );
}

test(
  "one Blast account can link both wallet kinds while global claims and primary selection remain safe",
  { skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 5 });
    let id = 10;
    const service = new AccountLinksService({
      clock: () => NOW,
      createId: () => `c1000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
      pool,
    });
    try {
      await migrateDatabase(pool);
      await seedAccount(pool, {
        address: EMBEDDED_A,
        callsign: "account_alpha",
        kind: "embedded",
        privySubject: "did:privy:account-alpha",
        profileId: ACCOUNT_A,
        xSubject: "x-account-alpha",
      });
      await seedAccount(pool, {
        address: SLUSH_B,
        callsign: "account_beta",
        kind: "slush",
        privySubject: "did:privy:account-beta",
        profileId: ACCOUNT_B,
        xSubject: "x-account-beta",
      });

      const linked = await service.attachWallet({
        address: SLUSH_A,
        kind: "slush",
        profileId: ACCOUNT_A,
        providerWalletReference: "slush:proof-account-alpha",
      });
      assert.deepEqual(
        linked.map(({ address, kind, primary }) => ({ address, kind, primary })),
        [
          { address: EMBEDDED_A, kind: "embedded", primary: true },
          { address: SLUSH_A, kind: "slush", primary: false },
        ],
      );

      const switched = await service.setPrimary(ACCOUNT_A, linked[1]!.id);
      assert.equal(switched.find(({ address }) => address === SLUSH_A)?.primary, true);
      assert.equal(switched.find(({ address }) => address === EMBEDDED_A)?.primary, false);

      await assert.rejects(
        service.attachWallet({
          address: SLUSH_A,
          kind: "embedded",
          profileId: ACCOUNT_B,
          providerWalletReference: "privy:stolen-wallet",
        }),
        (error: unknown) =>
          error instanceof AccountLinksError && error.code === "WALLET_ALREADY_LINKED",
      );

      await assert.rejects(
        service.attachWallet({
          address: EMBEDDED_B,
          identity: { provider: "privy", subject: "did:privy:account-alpha" },
          kind: "embedded",
          profileId: ACCOUNT_B,
          providerWalletReference: "privy:identity-conflict",
        }),
        (error: unknown) =>
          error instanceof AccountLinksError && error.code === "IDENTITY_ALREADY_LINKED",
      );

      const betaWallets = await service.listWallets(ACCOUNT_B);
      assert.deepEqual(betaWallets.map(({ address }) => address), [SLUSH_B]);

      await pool.query(
        `INSERT INTO mission_control_wallet_challenges (
           challenge_id, action, wallet_address, origin, context_kind, context_id,
           nonce_hash, message_hash, issued_at, expires_at, consumed_at
         ) VALUES (
           'd1000000-0000-4000-8000-000000000001', 'link_wallet', $1,
           'https://blast.fun', 'account', $2, $3, $4,
           $5::timestamptz, $5::timestamptz + INTERVAL '5 minutes', NULL
         )`,
        [EMBEDDED_A, `${ACCOUNT_A}:slush`, "a".repeat(64), "b".repeat(64), NOW],
      );
      const reapplied = await resetDatabase(pool);
      assert.ok(reapplied.includes("0012_canonical_blast_accounts"));

      await seedAccount(pool, {
        address: `0x${"55".repeat(32)}`,
        callsign: "account_gamma",
        kind: "slush",
        privySubject: "did:privy:account-gamma",
        profileId: ACCOUNT_C,
        xSubject: "x-account-gamma",
      });
      await seedAccount(pool, {
        address: `0x${"66".repeat(32)}`,
        callsign: "account_delta",
        kind: "slush",
        privySubject: "did:privy:account-delta",
        profileId: ACCOUNT_D,
        xSubject: "x-account-delta",
      });
      const contested = `0x${"77".repeat(32)}`;
      const results = await Promise.allSettled([
        service.attachWallet({
          address: contested,
          kind: "embedded",
          profileId: ACCOUNT_C,
          providerWalletReference: "privy:contested-gamma",
        }),
        service.attachWallet({
          address: contested,
          kind: "embedded",
          profileId: ACCOUNT_D,
          providerWalletReference: "privy:contested-delta",
        }),
      ]);
      assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
      const rejected = results.find(({ status }) => status === "rejected");
      assert.ok(rejected && rejected.status === "rejected");
      assert.ok(
        rejected.reason instanceof AccountLinksError &&
          rejected.reason.code === "WALLET_ALREADY_LINKED",
      );
    } finally {
      await pool.end();
    }
  },
);
