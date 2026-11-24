import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialRouteKit, SOCIAL_PUBLIC_CACHE_CONTROL } from "@blast/server/modules/social/route-kit/route.ts";
import { CardImageBusyError } from "@blast/core/modules/mission-control/card-images/contracts.ts";
import { renderSeasonZeroCardPng } from "@blast/server/modules/mission-control/card-renderer/render.ts";
import { createSeasonZeroCardRecord } from "@blast/core/modules/mission-control/card-renderer/contract.ts";
import { CARD_IDENTITY_PATH, OWNER_CARD_PATH } from "@blast/core/modules/social/contracts/card-identity.ts";
import { createCardIdentityRoute } from "@blast/server/modules/social/card-identity/route.ts";
import { createOwnerCardRoute } from "@blast/server/modules/social/card-identity/owner-route.ts";
import { seedCardIdentities } from "../../../../test/fixtures/modules/social/card-identity/testing.ts";

const url = process.env.MISSION_CONTROL_TEST_DATABASE_URL;

test("real runtime role serves all card editions and restricts unpublished artwork to its social owner", { skip: !url }, async () => {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const cards = await seedCardIdentities(admin);
  const web = createRuntimePool(urlAs(database.url, "blast_web"), { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 4, statementTimeoutMs: 5_000 }, "card-identity-test");
  try {
    const db = autocommitReader(web, "social");
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: "https://blast.fun", primary: () => web,
      verifyAccessToken: async (token) => ({ userId: `did:privy:${token}`, sessionId: "fixture", appId: "fixture", issuedAt: 0, expiration: 9999999999, issuer: "privy.io" }),
      accounts: new PostgresSocialAccounts(() => web),
      limiter: { consume: async (bucket) => ({ allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 }) },
    });
    const publicRead = createCardIdentityRoute({ kit, database: () => db });
    const names = [...cards.map(({ callsign }) => callsign), "no_card"];
    const publicResponse = await publicRead(new Request(`https://blast.fun${CARD_IDENTITY_PATH}?callsigns=${names.join(",")}`), testClient());
    assert.equal(publicResponse.status, 200, await publicResponse.clone().text());
    assert.equal(publicResponse.headers.get("cache-control"), SOCIAL_PUBLIC_CACHE_CONTROL);
    const identities = await publicResponse.json();
    for (const { callsign, record } of cards) assert.deepEqual(identities[callsign], {
      crew: record.crew, edition: record.edition, published_card_id: record.edition === "blast-launch-day" ? null : record.cardId,
    });
    assert.equal(identities.no_card, null);
    assert.doesNotMatch(JSON.stringify(identities), /bytesBase64|sha256|profile_id|privy|avatar|blob/);
    assert.equal((await publicRead(new Request(`https://blast.fun${CARD_IDENTITY_PATH}?callsigns=kai,invalid!`), testClient())).status, 400);

    const ownerRead = createOwnerCardRoute({ kit, database: () => db, images: { image: async ({ record, format }) => ({
      ...await renderSeasonZeroCardPng(createSeasonZeroCardRecord(record)), digest: "fixture", format: format ?? "card", source: "render",
    }) } });
    const request = (callsign?: string) => new Request(`https://blast.fun${OWNER_CARD_PATH}?card_id=${cards[0]!.record.cardId}`, {
      headers: callsign ? { authorization: `Bearer ${callsign}` } : {},
    });
    assert.equal((await ownerRead(request(), testClient())).status, 401);
    const owner = cards.find(({ record }) => record.edition === "blast-launch-day")!;
    const response = await ownerRead(request(owner.callsign), testClient());
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, 2100); assert.equal(metadata.height, 1500);
    const expected = await renderSeasonZeroCardPng(owner.record);
    assert.deepEqual(bytes, expected.bytes, "caller-supplied card id cannot select another owner's artwork");
    const busy = createOwnerCardRoute({ kit, database: () => db, images: { image: async () => { throw new CardImageBusyError("queue_full"); } } });
    const unavailable = await busy(request(owner.callsign), testClient());
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("cache-control"), "private, no-store");
  } finally { await Promise.all([admin.end(), web.end()]); await database.drop(); }
});
