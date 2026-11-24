import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { createPresaleReceiptLogo } from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import { makeSeasonZeroCardFixtures } from "../../../../../../packages/server/test/fixtures/modules/mission-control/card-renderer/fixtures.ts";
import { CARD_EDITIONS, cardEditionForCrew } from "@blast/core/modules/mission-control/card-renderer/editions.ts";
import { referralMetadata, referralMetadataFor } from "./share.ts";
import { referralRank } from "@blast/core/modules/social/referrals/share.ts";
import { referralShareSvg, renderReferralSharePng } from "@blast/server/modules/social/referrals/share-image.ts";
import { createReferralImageRoute } from "@blast/server/modules/social/referrals/share-route.ts";

const ranked = { callsign: "satoshimedici", crew: 21, title: "Flight Director", avatarUrl: "https://images.example/avatar.png" };
const noAvatar = async () => ({ logo: null, transient: false });
const unranked = { callsign: "new_friend", crew: null, title: null, avatarUrl: null };

test("referral metadata names the inviter, preserves attribution and replaces both social previews", () => {
  const metadata = referralMetadata(ranked);
  assert.deepEqual(metadata.title, { absolute: "satoshimedici invites you to BLAST.FUN" });
  assert.match(metadata.description!, /Flight Director · Quasar · Crew #21/);
  assert.equal(metadata.alternates?.canonical, "/");
  assert.match(JSON.stringify(metadata.openGraph), /\?ref=satoshimedici/);
  for (const tags of [metadata.openGraph, metadata.twitter]) {
    assert.match(JSON.stringify(tags), /satoshimedici invites you/);
    assert.match(JSON.stringify(tags), /\/referral\/satoshimedici\/image\?v=3-[a-f0-9]{16}/);
  }
});

test("accounts without a published rank still get a personal invite without an invented badge", () => {
  assert.equal(referralRank(unranked), null);
  assert.equal(referralMetadata(unranked).description, "Join @new_friend on BLAST.FUN.");
  assert.doesNotMatch(referralShareSvg(unranked), /SEASON ZERO|Crew #|Recruit/);
  for (const crew of [0, -1, 1.2, 1000000]) assert.equal(referralRank({ ...ranked, crew }), null);
});

test("malformed, duplicate, unknown and unavailable referrals use the normal page preview", async () => {
  for (const value of [undefined, "", "<script>", ["first", "second"]]) {
    assert.equal(await referralMetadataFor(value, async () => { throw new Error("must not read"); }), null);
  }
  assert.equal(await referralMetadataFor("unknown", async () => null), null);
  assert.equal(await referralMetadataFor("satoshimedici", async () => { throw new Error("offline"); }), null);
  const metadata = await referralMetadataFor("SatoshiMedici", async (callsign) => {
    assert.equal(callsign, "satoshimedici");
    return ranked;
  });
  assert.deepEqual(metadata?.title, referralMetadata(ranked).title);
});

test("image requests share one render and return only public PNGs with bounded cache lifetimes", async () => {
  let renders = 0;
  const route = createReferralImageRoute({ avatar: noAvatar, read: async () => ranked, render: async () => {
    renders++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Buffer.from("png");
  } });
  const responses = await Promise.all([route(ranked.callsign), route(ranked.callsign), route(ranked.callsign)]);
  assert.equal(renders, 1);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.match(response.headers.get("Cache-Control")!, /s-maxage=300/);
    assert.equal(await response.text(), "png");
  }
  await route(ranked.callsign);
  assert.equal(renders, 1);
});

test("invalid and missing inviters are not rendered; transient failures are not cached", async () => {
  let reads = 0;
  const missing = createReferralImageRoute({ avatar: noAvatar, read: async () => { reads++; return null; }, render: async () => { throw new Error("must not render"); } });
  assert.equal((await missing("<script>")).status, 404);
  assert.equal(reads, 0);
  assert.equal((await missing("unknown")).status, 404);
  let renders = 0;
  const retry = createReferralImageRoute({ avatar: noAvatar, read: async () => ranked, render: async () => {
    if (++renders === 1) throw new Error("temporary");
    return Buffer.from("png");
  } });
  const failure = await retry(ranked.callsign);
  assert.equal(failure.status, 503);
  assert.match(failure.headers.get("Cache-Control")!, /no-store/);
  assert.equal((await retry(ranked.callsign)).status, 200);
});

test("ranked, unranked and longest callsigns render 1200×675 social images", async () => {
  const [fixture] = await makeSeasonZeroCardFixtures();
  const avatar = createPresaleReceiptLogo(Buffer.from(fixture.record.avatar.bytesBase64, "base64"));
  for (const inviter of [ranked, unranked, { ...ranked, callsign: "wwwwwwwwwwwwwwwwwwww", crew: 727 }]) {
    const png = await renderReferralSharePng(inviter, avatar);
    const image = await sharp(png).metadata();
    assert.equal(image.width, 1200);
    assert.equal(image.height, 675);
    if (process.env.REFERRAL_PREVIEW_DIR) await writeFile(`${process.env.REFERRAL_PREVIEW_DIR}/${inviter.callsign}.png`, png);
  }
  assert.match(referralShareSvg({ ...ranked, title: "<script>&" }), /&lt;script&gt;&amp;/);
});


test("every rank has a renderable edition background, including special editions", async () => {
  const [fixture] = await makeSeasonZeroCardFixtures();
  const avatar = createPresaleReceiptLogo(Buffer.from(fixture.record.avatar.bytesBase64, "base64"));
  const crews = [1, 26, 51, 101, 151, 201, 301, 504, 1001, 69, 123, 256, 503, 727];
  assert.deepEqual(new Set(crews.map(cardEditionForCrew)), new Set(CARD_EDITIONS));
  for (const crew of crews) {
    const edition = cardEditionForCrew(crew);
    const inviter = { callsign: `${edition.replaceAll("-", "_")}_member`, crew, title: null, avatarUrl: null };
    const png = await renderReferralSharePng(inviter, avatar);
    assert.equal((await sharp(png).metadata()).width, 1200);
    if (process.env.REFERRAL_PREVIEW_DIR) await writeFile(`${process.env.REFERRAL_PREVIEW_DIR}/${edition}.png`, png);
  }
});


test("profile photos fill the square frame from top to bottom; missing photos use initials", async () => {
  const avatar = createPresaleReceiptLogo(await sharp({ create: {
    width: 512, height: 512, channels: 3, background: { r: 210, g: 30, b: 80 },
  } }).png().toBuffer());
  const png = await renderReferralSharePng(ranked, avatar);
  for (const top of [200, 335, 470]) {
    const pixel = await sharp(png).extract({ left: 210, top, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...pixel], [210, 30, 80]);
  }
  assert.match(referralShareSvg(ranked, undefined, avatar), /clip-path="url\(#avatar\)"/);
  assert.match(referralShareSvg(ranked), />SA<\/text>/);
});

test("the route passes the current avatar into rendering and invalidates previews when it changes", async () => {
  const avatar = createPresaleReceiptLogo(await sharp({ create: { width: 512, height: 512, channels: 3, background: "red" } }).png().toBuffer());
  let inviter = ranked;
  const requested: (string | null)[] = [];
  let renders = 0;
  const route = createReferralImageRoute({
    read: async () => inviter,
    avatar: async (url) => { requested.push(url); return { logo: avatar, transient: false }; },
    render: async (_person, photo) => { assert.equal(photo, avatar); renders++; return Buffer.from("png"); },
  });
  await route(ranked.callsign);
  await route(ranked.callsign);
  assert.equal(renders, 1);
  inviter = { ...ranked, avatarUrl: "https://images.example/new-avatar.png" };
  await route(ranked.callsign);
  assert.equal(renders, 2);
  assert.deepEqual(requested, [ranked.avatarUrl, inviter.avatarUrl]);
  assert.notDeepEqual(referralMetadata(ranked).openGraph?.images, referralMetadata(inviter).openGraph?.images);
});

test("a temporary avatar failure renders initials without caching the fallback", async () => {
  let attempts = 0;
  let renders = 0;
  const route = createReferralImageRoute({
    read: async () => ranked,
    avatar: async () => ({ logo: null, transient: ++attempts === 1 }),
    render: async (_person, avatar) => { assert.equal(avatar, null); renders++; return Buffer.from("png"); },
  });
  const fallback = await route(ranked.callsign);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get("Cache-Control"), "private, no-store");
  assert.match((await route(ranked.callsign)).headers.get("Cache-Control")!, /s-maxage=300/);
  assert.equal(renders, 2);
});
