import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The flag reaches Portfolio only through these two places; the context defaults to on, so a test of the view alone would pass without them.
test("#602: SocialShell provides the layout's launchpad flag; the old /portfolio/launches link opens Claims, whose launch lists follow the flag", () => {
  const shell = readFileSync(new URL("./SocialShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /<LaunchpadFlagProvider value=\{launchpad\}>/);
  assert.match(shell, /<\/LaunchpadFlagProvider>/);
  const page = readFileSync(new URL("../../app/(app)/(social)/portfolio/launches/page.tsx", import.meta.url), "utf8");
  assert.match(page, /permanentRedirect\(SOCIAL_PAGE_PATHS\.portfolioClaims\)/);
});
