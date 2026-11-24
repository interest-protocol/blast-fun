import assert from "node:assert/strict";
import test from "node:test";

import { xPhotoCandidates, xPhotoOriginalUrl } from "./x-photo-url.ts";

const ORIGINAL = "https://pbs.twimg.com/profile_images/1800000000000000000/AbCd_ef.jpg";

test("every size of an X photo maps to the one original URL", () => {
  for (const suffix of ["_normal", "_mini", "_bigger", "_200x200", "_400x400", ""]) {
    assert.equal(xPhotoOriginalUrl(ORIGINAL.replace(".jpg", `${suffix}.jpg`)), ORIGINAL, suffix);
  }
  assert.equal(
    xPhotoOriginalUrl("https://pbs.twimg.com/profile_images/1/J9MPCcw5_normal"),
    "https://pbs.twimg.com/profile_images/1/J9MPCcw5",
  );
  assert.equal(
    xPhotoOriginalUrl("https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png"),
    "https://abs.twimg.com/sticky/default_profile_images/default_profile.png",
  );
  assert.equal(xPhotoOriginalUrl(`${ORIGINAL}?v=1#x`), ORIGINAL);
});

test("anything that is not an X profile photo is refused", () => {
  for (const reference of [
    "https://pbs.twimg.com/media/AbCd_normal.jpg",
    "https://pbs.twimg.com.evil.example/profile_images/1/AbCd_normal.jpg",
    "https://evil.example/profile_images/1/AbCd_normal.jpg",
    "http://pbs.twimg.com/profile_images/1/AbCd_normal.jpg",
    "https://user:pw@pbs.twimg.com/profile_images/1/AbCd_normal.jpg",
    "https://blob.blast.fun/pictures/5f2c.webp",
    "data:image/png;base64,iVBORw0KGgo=",
    "not a url",
  ]) {
    assert.equal(xPhotoOriginalUrl(reference), null, reference);
  }
});

test("candidates are the original, then the 400 px size, for any stored size", () => {
  const sized = ORIGINAL.replace(".jpg", "_400x400.jpg");
  for (const suffix of ["_normal", "_400x400", ""]) {
    assert.deepEqual(xPhotoCandidates(ORIGINAL.replace(".jpg", `${suffix}.jpg`)), [ORIGINAL, sized], suffix);
  }
  assert.deepEqual(xPhotoCandidates("https://pbs.twimg.com/profile_images/1/J9MPCcw5_normal"), [
    "https://pbs.twimg.com/profile_images/1/J9MPCcw5",
    "https://pbs.twimg.com/profile_images/1/J9MPCcw5_400x400",
  ]);
  assert.deepEqual(xPhotoCandidates("https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png"), [
    "https://abs.twimg.com/sticky/default_profile_images/default_profile.png",
    "https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png",
  ]);
  assert.deepEqual(xPhotoCandidates("https://pbs.twimg.com.evil.example/profile_images/1/a.jpg"), []);
});
