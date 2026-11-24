#!/usr/bin/env node
// Manual probe against real X, never run in CI: node scripts/probe-x-photo.mjs [photo-url ...]
// Prints the status of each candidate URL Blast tries for a photo, in order
// (original, then _400x400), plus the other sizes for reference. Passes when
// at least one candidate answers with an image. With no arguments it probes
// a photo that exists only as _400x400 (the original and every other size 404):
//   node scripts/probe-x-photo.mjs https://pbs.twimg.com/profile_images/2102957396393938944/9KRGqxu0.jpg
import { xPhotoCandidates, xPhotoOriginalUrl } from "@blast/core/lib/x-photo-url.ts";

const DEFAULT = "https://pbs.twimg.com/profile_images/2102957396393938944/9KRGqxu0.jpg";
const OTHER_SIZES = ["_normal", "_bigger", "_mini", "_200x200"];

async function probe(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  await response.body?.cancel();
  return { status: response.status, image: response.ok && Boolean(response.headers.get("content-type")?.startsWith("image/")) };
}

let failed = false;
for (const reference of process.argv.length > 2 ? process.argv.slice(2) : [DEFAULT]) {
  const candidates = xPhotoCandidates(reference);
  if (!candidates.length) {
    console.log(`SKIP  not an X profile photo: ${reference}`);
    failed = true;
    continue;
  }
  console.log(reference);
  let winner = null;
  for (const [index, url] of candidates.entries()) {
    const { status, image } = await probe(url);
    console.log(`  candidate ${index + 1} ${status} ${image ? "image" : "-"}  ${url.slice(url.lastIndexOf("/") + 1)}`);
    if (image && !winner) winner = index + 1;
  }
  const original = xPhotoOriginalUrl(reference);
  const dot = original.lastIndexOf(".");
  const [stem, extension] = dot > original.lastIndexOf("/") ? [original.slice(0, dot), original.slice(dot)] : [original, ""];
  for (const suffix of OTHER_SIZES) console.log(`  reference ${suffix} ${(await probe(`${stem}${suffix}${extension}`)).status}`);
  if (winner) console.log(`  OK    candidate ${winner} answers`);
  else {
    console.log("  FAIL  no candidate answers with an image");
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
