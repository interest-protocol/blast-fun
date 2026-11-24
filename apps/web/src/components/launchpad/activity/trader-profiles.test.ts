import assert from "node:assert/strict";
import test from "node:test";
import { loadTraderProfiles } from "./trader-profiles.ts";
import { traderProfileKey } from "@blast/core/modules/social/contracts/trader-profiles.ts";
const trader = { address: `0x${"a".repeat(64)}`, timestampMs: 10 };
const key = traderProfileKey(trader);
test("profile reads accept exact keys, omit credentials and never cache", async () => {
  const request: typeof fetch = async (_url, init) => {
    assert.equal(init?.credentials, "omit"); assert.equal(init?.cache, "no-store");
    return Response.json({ [key]: { callsign: "alice", avatarUrl: null } });
  };
  assert.deepEqual(await loadTraderProfiles([trader], new AbortController().signal, request), { [key]: { callsign: "alice", avatarUrl: null } });
});
test("profile errors and invalid or mismatched responses reject for neutral fallback", async () => {
  for (const response of [new Response(null, { status: 503 }), Response.json({}), Response.json({ [key]: { callsign: "!", avatarUrl: null } }), Response.json({ wrong: null })]) {
    await assert.rejects(loadTraderProfiles([trader], new AbortController().signal, async () => response));
  }
});
