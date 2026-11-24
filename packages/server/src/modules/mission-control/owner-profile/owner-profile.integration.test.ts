import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Pool } from "pg";

import {
  createApprovedXAvatarSnapshot,
  createSeasonZeroCardRecord,
} from "@blast/server/modules/mission-control/card-renderer/index.ts";
import {
  CardImageBusyError,
  CardImageService,
  FilesystemCardImageStore,
  PostgresCardImageCatalog,
  renderCardImageWithSharp,
} from "@blast/server/modules/mission-control/card-images/index.ts";
import {
  createPool,
  migrateDatabase,
  resetDatabase,
} from "@blast/core/modules/database/admin.ts";
import { OwnerRecruitCursorCodec } from "@blast/server/modules/mission-control/owner-profile/cursor.server.ts";
import { OwnerProfileError } from "@blast/server/modules/mission-control/owner-profile/errors.ts";
import { OwnerProfileService } from "@blast/server/modules/mission-control/owner-profile/service.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_OWNER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-09-20T12:00:00.000Z");

async function insertProfile(
  pool: Pool,
  input: {
    callsign: string;
    crewNumber: number;
    id: string;
    providerWalletReference?: string;
  },
) {
  const byte = input.crewNumber.toString(16).padStart(2, "0").slice(-2);
  const membershipId = randomUUID();
  const cardId = randomUUID();
  await pool.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, x_handle, x_display_name,
       x_avatar_reference, sui_address, provider_wallet_reference,
       callsign, display_name, avatar_reference, disclosure_version,
       disclosure_accepted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'v1', $12)`,
    [
      input.id,
      `did:privy:private-${input.id}`,
      `x-private-${input.id}`,
      `x_${input.callsign}`,
      `X ${input.callsign}`,
      `https://pbs.twimg.com/${input.callsign}.png`,
      `0x${byte.repeat(32)}`,
      input.providerWalletReference ?? `privy:embedded-${input.id}`,
      input.callsign,
      `Display ${input.crewNumber}`,
      null,
      NOW,
    ],
  );
  const walletAddress = `0x${byte.repeat(32)}`;
  const providerWalletReference =
    input.providerWalletReference ?? `privy:embedded-${input.id}`;
  await pool.query(
    `INSERT INTO mission_control_account_identities (
       profile_id, provider, provider_subject, verified_at
     ) VALUES ($1, 'x', $2, $4), ($1, 'privy', $3, $4)`,
    [input.id, `x-private-${input.id}`, `did:privy:private-${input.id}`, NOW],
  );
  await pool.query(
    `INSERT INTO mission_control_account_wallets (
       wallet_id, profile_id, wallet_kind, sui_address,
       provider_wallet_reference, is_primary, verified_at
     ) VALUES ($1, $1, $2, $3, $4, TRUE, $5)`,
    [
      input.id,
      providerWalletReference.startsWith("slush:") ? "slush" : "embedded",
      walletAddress,
      providerWalletReference,
      NOW,
    ],
  );
  await pool.query(
    `INSERT INTO mission_control_season_memberships (
       membership_id, allocation_id, card_id, season_id, profile_id,
       crew_number, fleet, foundry_launch_method, owner_title,
       zero_fleet, gold, created_at
     ) VALUES ($1, $2, $3, 'season-zero', $4, $5, 'Recon', NULL, $6, $7, $7, $8)`,
    [
      membershipId,
      randomUUID(),
      cardId,
      input.id,
      input.crewNumber,
      input.crewNumber <= 100 ? "Zero Fleet Commando" : "Recon Fleet",
      input.crewNumber <= 100,
      NOW,
    ],
  );
  return { cardId, membershipId };
}

async function seedOwnerGraph(pool: Pool) {
  const owner = await insertProfile(
    pool,
    { callsign: "owner_alpha", crewNumber: 1, id: OWNER_ID },
  );
  await insertProfile(pool, {
    callsign: "owner_beta",
    crewNumber: 2,
    id: SECOND_OWNER_ID,
    providerWalletReference: `slush:${randomUUID()}`,
  });
  const cardRecord = createSeasonZeroCardRecord({
    avatar: createApprovedXAvatarSnapshot(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
      "image/png",
    ),
    callsign: "owner_alpha",
    cardId: owner.cardId,
    crew: 1,

    title: "CAPCOM",
  });
  await pool.query(
    `INSERT INTO mission_control_cards (
       card_id, profile_id, membership_id, record_schema, record_version,
       card_record, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      owner.cardId,
      OWNER_ID,
      owner.membershipId,
      cardRecord.schema,
      cardRecord.version,
      JSON.stringify(cardRecord),
      NOW,
    ],
  );

  for (let index = 0; index < 31; index += 1) {
    const profileId = `10000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`;
    await insertProfile(pool, {
      callsign: `recruit_${index.toString().padStart(2, "0")}`,
      crewNumber: 101 + index,
      id: profileId,
    });
    const sourceCodeId = randomUUID();
    await pool.query(
      `INSERT INTO mission_control_invitation_codes (
         code_id, season_id, lookup_key_version, lookup_hmac,
         encrypted_display, encryption_iv, encryption_tag,
         encryption_key_version, enabled, consumed_at, code_kind,
         consumed_by_profile_id
       ) VALUES ($1, 'season-zero', 'test-v1', $2, 'source', 'aXY=', 'dGFn',
         'test-v1', TRUE, $3, 'team', $4)`,
      [
        sourceCodeId,
        createHash("sha256").update(`source-${index}`).digest("hex"),
        new Date(NOW.getTime() + index * 1_000),
        profileId,
      ],
    );
    await pool.query(
      `INSERT INTO mission_control_referrals (
         recruited_profile_id, referrer_profile_id, source_code_id, created_at
       ) VALUES ($1, $2, $3, $4)`,
      [profileId, OWNER_ID, sourceCodeId, new Date(NOW.getTime() + index * 1_000)],
    );
  }

  for (const index of [0, 1]) {
    await pool.query(
      `INSERT INTO mission_control_invitation_codes (
         code_id, season_id, lookup_key_version, lookup_hmac,
         encrypted_display, encryption_iv, encryption_tag,
         encryption_key_version, enabled, consumed_at, code_kind,
         owner_profile_id, consumed_by_profile_id
       ) VALUES ($1, 'season-zero', $2, $3, $4, $5, $6, $7, TRUE, $8,
         'member', $9, $10)`,
      [
        randomUUID(),
        "test-v1",
        createHash("sha256").update(`first-owner-${index}`).digest("hex"),
        "fixture",
        "aXY=",
        "dGFn",
        "test-v1",
        index === 0 ? null : NOW,
        OWNER_ID,
        index === 0 ? null : SECOND_OWNER_ID,
      ],
    );
  }
}

test(
  "owner profile reads remain private, paginated, live, and code-safe against PostgreSQL",
  { skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    const imageDirectory = await mkdtemp(join(tmpdir(), "owner-card-images-"));
    const service = new OwnerProfileService({
      cardImages: new CardImageService({
        memoryCacheBytes: 0,
        persistence: {
          catalog: new PostgresCardImageCatalog(pool),
          store: new FilesystemCardImageStore(imageDirectory),
        },
        render: renderCardImageWithSharp,
      }),
      cursor: new OwnerRecruitCursorCodec(Buffer.alloc(32, 9)),
      pool,
    });

    try {
      await migrateDatabase(pool);
      await seedOwnerGraph(pool);

      const owner = await service.getOwner(OWNER_ID);
      assert.equal(owner.recruitTotal, 31);
      assert.equal(owner.codeTotal, 2);
      assert.equal(owner.profile.callsign, "owner_alpha");
      assert.equal(owner.wallet.address.length, 66);
      assert.deepEqual(owner.wallet, {
        address: `0x${"01".repeat(32)}`,
        kind: "embedded",
        state: "verified",
      });
      assert.equal(owner.social.verified, true);
      assert.doesNotMatch(
        JSON.stringify(owner),
        /private-|provider-secret|foundryLaunchMethod|privy|xSubject/i,
      );

      const first = await service.getRecruits(OWNER_ID, null, 25);
      assert.equal(first.items.length, 25);
      assert.equal(first.items[0]?.callsign, "recruit_30");
      assert.ok(first.nextCursor);
      assert.doesNotMatch(first.nextCursor, /recruit|10000000|2026/);
      const second = await service.getRecruits(OWNER_ID, first.nextCursor, 25);
      assert.equal(second.items.length, 6);
      assert.equal(second.nextCursor, null);
      assert.equal(
        new Set([...first.items, ...second.items].map((item) => item.callsign)).size,
        31,
      );

      assert.equal((await service.getRecruits(SECOND_OWNER_ID, null, 25)).items.length, 0);
      assert.deepEqual((await service.getOwner(SECOND_OWNER_ID)).wallet, {
        address: `0x${"02".repeat(32)}`,
        kind: "slush",
        state: "verified",
      });

      // Historical creator codes contribute referrals without inflating member code counts.
      const creatorId = randomUUID();
      await pool.query(
        `INSERT INTO mission_control_seed_creators (
           seed_creator_id, season_id, display_name, expected_x_handle,
           x_subject, profile_id, claimed_at
         ) VALUES ($1, 'season-zero', 'Beta Creator', 'owner_beta', $2, $3, $4)`,
        [creatorId, `x-private-${SECOND_OWNER_ID}`, SECOND_OWNER_ID, NOW],
      );
      await pool.query(
        `INSERT INTO mission_control_seed_code_groups (
           seed_code_group_id, seed_creator_id, group_label
         ) VALUES ($1, $1, 'Beta Creator')`,
        [creatorId],
      );
      const creatorCodeIds = [randomUUID(), randomUUID()];
      const creatorRecruitId = "20000000-0000-4000-8000-000000000001";
      await insertProfile(pool, {
        callsign: "creator_recruit",
        crewNumber: 200,
        id: creatorRecruitId,
      });
      for (const index of [0, 1]) {
        await pool.query(
          `INSERT INTO mission_control_invitation_codes (
             code_id, season_id, lookup_key_version, lookup_hmac,
             encrypted_display, encryption_iv, encryption_tag,
             encryption_key_version, enabled, consumed_at, code_kind,
             seed_creator_id, seed_code_group_id, consumed_by_profile_id, created_at
           ) VALUES ($1, 'season-zero', $2, $3, $4, $5, $6, $7, TRUE, $8,
             'creator', $9, $9, $10, $11)`,
          [
            creatorCodeIds[index],
            "test-v1",
            createHash("sha256").update(`creator-${index}`).digest("hex"),
            "fixture",
            "aXY=",
            "dGFn",
            "test-v1",
            index === 0 ? null : NOW,
            creatorId,
            index === 0 ? null : creatorRecruitId,
            new Date(NOW.getTime() + index * 1_000),
          ],
        );
      }
      await pool.query(
        `INSERT INTO mission_control_seed_creator_attributions (
           recruited_profile_id, seed_creator_id, source_code_id, created_at
         ) VALUES ($1, $2, $3, $4)`,
        [creatorRecruitId, creatorId, creatorCodeIds[1], NOW],
      );
      const creatorOwner = await service.getOwner(SECOND_OWNER_ID);
      assert.equal(creatorOwner.codeTotal, 0);
      assert.equal(creatorOwner.recruitTotal, 1);
      assert.deepEqual(
        (await service.getRecruits(SECOND_OWNER_ID, null, 25)).items.map((item) => item.callsign),
        ["creator_recruit"],
      );
      assert.equal((await service.getOwner(OWNER_ID)).codeTotal, 2);

      // Historical member code counts stay separate from original creator codes.
      for (const index of [0, 1]) {
        await pool.query(
          `INSERT INTO mission_control_invitation_codes (
             code_id, season_id, lookup_key_version, lookup_hmac,
             encrypted_display, encryption_iv, encryption_tag,
             encryption_key_version, enabled, consumed_at, code_kind,
             owner_profile_id, consumed_by_profile_id, created_at
           ) VALUES ($1, 'season-zero', $2, $3, $4, $5, $6, $7, TRUE, $8,
             'member', $9, $10, $11)`,
          [
            randomUUID(),
            "test-v1",
            createHash("sha256").update(`second-owner-${index}`).digest("hex"),
            "fixture",
            "aXY=",
            "dGFn",
            "test-v1",
            index === 0 ? null : NOW,
            SECOND_OWNER_ID,
            index === 0 ? null : OWNER_ID,
            new Date(NOW.getTime() + index * 1_000),
          ],
        );
      }
      assert.equal((await service.getOwner(SECOND_OWNER_ID)).codeTotal, 2);
      assert.equal((await service.getOwner(SECOND_OWNER_ID)).recruitTotal, 1);
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS total FROM mission_control_invitation_codes WHERE seed_creator_id = $1",
        [creatorId],
      )).rows[0].total, 2);

      const cardBefore = await pool.query(
        "SELECT card_record, render_status, rendered_at, render_error FROM mission_control_cards WHERE profile_id = $1",
        [OWNER_ID],
      );
      const image = await service.getCardImage(OWNER_ID);
      assert.equal(image.callsign, "owner_alpha");
      assert.equal(image.image.contentType, "image/png");
      assert.equal(image.image.width, 2100);
      assert.equal(image.image.height, 1500);
      assert.ok(image.image.bytes.byteLength > 1_000);
      const cardAfter = await pool.query(
        "SELECT card_record, render_status, rendered_at, render_error FROM mission_control_cards WHERE profile_id = $1",
        [OWNER_ID],
      );
      assert.deepEqual(cardAfter.rows, cardBefore.rows);
      const persisted = await pool.query<{ format: string; byte_size: number }>(
        "SELECT format, byte_size FROM mission_control_card_images",
      );
      assert.deepEqual(persisted.rows, [
        { byte_size: image.image.bytes.byteLength, format: "card" },
      ]);
      // A shed render is told apart from a failed one, so the route can ask for a retry.
      for (const [failure, code] of [
        [new CardImageBusyError("queue_full"), "CARD_BUSY"],
        [new Error("rasterizer outage"), "CARD_UNAVAILABLE"],
      ] as const) {
        const failing = new OwnerProfileService({
          cardImages: { image: async () => { throw failure; } },
          cursor: new OwnerRecruitCursorCodec(Buffer.alloc(32, 9)),
          pool,
        });
        await assert.rejects(
          failing.getCardImage(OWNER_ID, "share"),
          (error: unknown) => error instanceof OwnerProfileError && error.code === code,
        );
      }

      assert.equal(
        (await service.updateDisplayName(OWNER_ID, "  New   Name ")).resolvedDisplayName,
        "New Name",
      );
      assert.equal(
        (await service.updateDisplayName(OWNER_ID, null)).resolvedDisplayName,
        "owner_alpha",
      );
    } finally {
      await resetDatabase(pool);
      await pool.end();
      await rm(imageDirectory, { force: true, recursive: true });
    }
  },
);
