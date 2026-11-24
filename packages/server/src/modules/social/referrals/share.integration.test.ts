import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { createSeasonZeroCardRecord } from "@blast/core/modules/mission-control/card-renderer/contract.ts";
import { makeSeasonZeroCardFixtures } from "../../../../test/fixtures/modules/mission-control/card-renderer/fixtures.ts";
import { readReferralInviter } from "@blast/server/modules/social/referrals/share-read.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;

test("runtime lookup supports social accounts, Mission Control members, and only published ranks", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const runtime = new Pool({ connectionString: urlAs(databaseUrl, "blast_web"), max: 1 });
  try {
    await migrateDatabase(admin);
    const db = autocommitReader(runtime, "social");
    await admin.query(`INSERT INTO social_accounts (account_id, privy_did, callsign)
      VALUES ($1, 'did:privy:referral-new', 'new_friend')`, [randomUUID()]);
    assert.deepEqual(await readReferralInviter(db, "new_friend"), { callsign: "new_friend", crew: null, title: null, avatarUrl: null });
    assert.equal(await readReferralInviter(db, "missing"), null);
    assert.equal(await readReferralInviter(db, "' OR true --"), null);

    await admin.query("UPDATE social_accounts SET x_avatar_url = 'https://images.example/new-friend.png' WHERE callsign = 'new_friend'");
    assert.equal((await readReferralInviter(db, "new_friend"))?.avatarUrl, "https://images.example/new-friend.png");

    const profileId = randomUUID();
    const membershipId = randomUUID();
    const cardId = randomUUID();
    await admin.query(`INSERT INTO mission_control_profiles (
      profile_id, privy_did, x_subject, sui_address, provider_wallet_reference, callsign, disclosure_version, disclosure_accepted_at
    ) VALUES ($1, 'did:privy:referral-member', 'referral-member', $2, 'referral-wallet', 'satoshimedici', 'v1', now())`,
    [profileId, `0x${"ab".repeat(32)}`]);
    assert.deepEqual(await readReferralInviter(db, "satoshimedici"), { callsign: "satoshimedici", crew: null, title: null, avatarUrl: null });
    await admin.query(`INSERT INTO mission_control_season_memberships (
      membership_id, allocation_id, card_id, season_id, profile_id, crew_number, fleet, foundry_launch_method,
      owner_title, zero_fleet, gold, created_at
    ) VALUES ($1, $2, $3, 'season-zero', $4, 1001, 'Recon', NULL, 'Recon Fleet', FALSE, FALSE, now())`,
    [membershipId, randomUUID(), cardId, profileId]);
    const [fixture] = await makeSeasonZeroCardFixtures();
    const record = createSeasonZeroCardRecord({ avatar: fixture.record.avatar, callsign: "satoshimedici", cardId, crew: 1001, title: "Telemetry" });
    await admin.query(`INSERT INTO mission_control_cards (
      card_id, profile_id, membership_id, record_schema, record_version, card_record, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, now())`, [cardId, profileId, membershipId, record.schema, record.version, record]);
    assert.equal((await readReferralInviter(db, "satoshimedici"))?.crew, null);
    await admin.query("UPDATE mission_control_cards SET published_at = now() WHERE card_id = $1", [cardId]);
    const expected: { callsign: string; crew: number; title: string; avatarUrl: string | null } = { callsign: "satoshimedici", crew: 1001, title: "Telemetry", avatarUrl: null };
    assert.deepEqual(await readReferralInviter(db, "satoshimedici"), expected);
    await admin.query("UPDATE mission_control_profiles SET x_avatar_reference = 'https://images.example/member.png' WHERE profile_id = $1", [profileId]);
    expected.avatarUrl = "https://images.example/member.png";
    assert.deepEqual(await readReferralInviter(db, "satoshimedici"), expected);
    await admin.query("INSERT INTO social_accounts (account_id, profile_id) VALUES ($1, $2)", [randomUUID(), profileId]);
    assert.deepEqual(await readReferralInviter(db, "satoshimedici"), expected);
    await admin.query("UPDATE social_accounts SET picture = 'upload', picture_url = 'https://images.example/upload.png' WHERE profile_id = $1", [profileId]);
    assert.equal((await readReferralInviter(db, "satoshimedici"))?.avatarUrl, "https://images.example/upload.png");
    await admin.query("UPDATE social_accounts SET picture = 'none', picture_url = NULL WHERE profile_id = $1", [profileId]);
    assert.equal((await readReferralInviter(db, "satoshimedici"))?.avatarUrl, null);
  } finally {
    await runtime.end();
    await admin.end();
  }
});
