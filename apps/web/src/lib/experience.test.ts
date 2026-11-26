import assert from "node:assert/strict";
import test from "node:test";

import { isBlastExperienceEnabled } from "./experience.ts";
import {
  SITE_SOCIAL_IMAGE_ALT,
  SITE_SOCIAL_IMAGE_URL,
  SITE_SOCIAL_SHARE_URL,
  LANDING_BRAND,
} from "./site.ts";
import { siteMetadata } from "./site-metadata.ts";
test("the experience is disabled unless the server explicitly enables it", () => {
  const previous = process.env.BLAST_EXPERIENCE_ENABLED;
  try {
    delete process.env.BLAST_EXPERIENCE_ENABLED;
    assert.equal(isBlastExperienceEnabled(), false);
    for (const value of ["", "false", "0", "1", "TRUE", "true "]) {
      process.env.BLAST_EXPERIENCE_ENABLED = value;
      assert.equal(isBlastExperienceEnabled(), false, value);
    }
    process.env.BLAST_EXPERIENCE_ENABLED = "true";
    assert.equal(isBlastExperienceEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.BLAST_EXPERIENCE_ENABLED;
    else process.env.BLAST_EXPERIENCE_ENABLED = previous;
  }
});

test("the homepage uses the current Blast social card", () => {
  assert.equal(SITE_SOCIAL_IMAGE_URL, "https://www.blast.fun/landing/social-card.png?v=20260925");

  assert.equal(LANDING_BRAND.socialImageUrl, SITE_SOCIAL_IMAGE_URL);
  assert.equal(LANDING_BRAND.socialImageAlt, SITE_SOCIAL_IMAGE_ALT);
});

test("the fresh social URL has its own Open Graph cache identity", () => {
  assert.equal(SITE_SOCIAL_SHARE_URL, "https://www.blast.fun/launch");

  const metadata = siteMetadata(SITE_SOCIAL_SHARE_URL);
  assert.equal(metadata.openGraph?.url, SITE_SOCIAL_SHARE_URL);
  // Each page names its own address; a site-wide default would point every page at Home.
  assert.equal(metadata.alternates, undefined);
  assert.deepEqual(metadata.twitter?.images, [
    {
      url: SITE_SOCIAL_IMAGE_URL,
      alt: SITE_SOCIAL_IMAGE_ALT,
    },
  ]);
});
