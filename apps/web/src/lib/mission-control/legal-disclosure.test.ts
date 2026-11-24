import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const unavailableControls = [
  "hide",
  "delete",
  "merge",
  "unlink X",
  "change the wallet|wallet replacement",
];

test("legal pages disclose Season Zero fields and do not promise unavailable controls", async () => {
  const [privacy, terms, legalShell] = await Promise.all([
    readFile(new URL("../../app/privacy/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/terms/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/legal/LegalPage.tsx", import.meta.url), "utf8"),
  ]);
  const content = `${privacy}\n${terms}`;

  for (const required of [
    "verified X",
    "full Sui wallet address",
    "Privy",
    "Slush",
    "completed-recruit total",
    "code used to complete",
    "currently disabled",
  ]) {
    assert.match(content, new RegExp(required, "i"));
  }
  for (const phrase of unavailableControls) {
    assert.match(content, new RegExp(phrase, "i"));
  }
  assert.doesNotMatch(content, /you can (hide|delete|merge|unlink|change) (your )?(season zero )?profile/i);
  assert.doesNotMatch(legalShell, />Launchpad</);
  assert.doesNotMatch(legalShell, />Mission Control</);
});
