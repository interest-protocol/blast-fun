import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createPresaleReceiptLogo } from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import { fetchReferralAvatar } from "@blast/server/modules/social/referrals/share-avatar.ts";

const thumbnail = "https://pbs.twimg.com/profile_images/123/pilot_normal.jpg";
const original = thumbnail.replace("_normal", "");
const sized = thumbnail.replace("_normal", "_400x400");

test("referral cards fetch the original X portrait first", async () => {
  const logo = createPresaleReceiptLogo(await sharp({ create: {
    width: 400, height: 400, channels: 3, background: "pink",
  } }).png().toBuffer());
  for (const size of ["normal", "mini", "bigger", "200x200", "400x400"]) {
    const result = await fetchReferralAvatar(thumbnail.replace("normal", size), async (url) => {
      assert.equal(url, original);
      return { logo };
    });
    assert.equal(result.logo, logo);
  }
});

test("uploaded photos, original X photos, and unrelated URLs pass unchanged through the guarded loader", async () => {
  for (const reference of [
    "https://uploads.example/portrait_normal.jpg",
    "https://pbs.twimg.com.evil.example/profile_images/123/pilot_normal.jpg",
    "https://pbs.twimg.com/media/pilot_normal.jpg",
    "https://user:password@pbs.twimg.com/profile_images/123/pilot_normal.jpg",
    "not a url",
  ]) {
    let calls = 0;
    await fetchReferralAvatar(reference, async (url) => {
      calls++;
      assert.equal(url, reference);
      return { logo: null, reason: "not_raster", transient: false };
    });
    assert.equal(calls, 1);
  }
});

test("a photo X serves only at 400 px (original 404) is found on the second candidate", async () => {
  const logo = createPresaleReceiptLogo(await sharp({ create: {
    width: 400, height: 400, channels: 3, background: "pink",
  } }).png().toBuffer());
  const requested: string[] = [];
  const result = await fetchReferralAvatar(thumbnail, async (url) => {
    requested.push(url);
    return url === sized ? { logo } : { logo: null, reason: "http_status", transient: false };
  });
  assert.equal(result.logo, logo);
  assert.deepEqual(requested, [original, sized]);
});

test("when every candidate is missing the saved photo is the last try", async () => {
  const requested: string[] = [];
  await fetchReferralAvatar(thumbnail, async (url) => {
    requested.push(url);
    return { logo: null, reason: "http_status", transient: false };
  });
  assert.deepEqual(requested, [original, sized, thumbnail]);
});

test("a temporary high-resolution failure stays retryable instead of caching a blurry fallback", async () => {
  const requested: string[] = [];
  const failure = { logo: null, reason: "timeout", transient: true } as const;
  assert.equal(await fetchReferralAvatar(thumbnail, async (url) => {
    requested.push(url);
    return failure;
  }), failure);
  assert.deepEqual(requested, [original]);
});
