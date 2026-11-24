import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createActivityStreamFixture, activityWallets, activityOrigin, accountId } from "../../../../test/fixtures/workspace/activity-stream-fixture.ts";
import { traderProfilesPath, traderProfileKey } from "@blast/core/modules/social/contracts/trader-profiles.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
test("trader profiles enforce event-time public naming on replica and uncached route", { skip: !databaseUrl }, async () => {
  const fixture = await createActivityStreamFixture(databaseUrl!, Date.now());
  try {
    const { now, admin } = fixture;
    const read = (traders: Parameters<typeof traderProfilesPath>[0]) => fixture.routes().TRADER_PROFILES(new Request(activityOrigin + traderProfilesPath(traders), { headers: { "x-forwarded-for": "203.0.113.91" } }), testClient("203.0.113.91"));
    const before = { address: activityWallets.late, timestampMs: now - 1001 };
    const after = { ...before, timestampMs: now - 1000 };
    const privateTrader = { address: activityWallets.private, timestampMs: now };
    const unlinked = { address: `0x${"f".repeat(64)}`, timestampMs: now };
    const response = await read([before, after, privateTrader, unlinked]);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), {
      [traderProfileKey(before)]: null,
      [traderProfileKey(after)]: { callsign: "late", avatarUrl: null },
      [traderProfileKey(privateTrader)]: null,
      [traderProfileKey(unlinked)]: null,
    });
    await admin.query("UPDATE social_account_wallets SET verified_at = to_timestamp($1::numeric / 1000) WHERE address = $2", [now - 999.5, after.address]);
    assert.deepEqual(await (await read([after])).json(), { [traderProfileKey(after)]: null });
    const linked = { ...after, timestampMs: now - 999 };
    assert.deepEqual(await (await read([linked])).json(), { [traderProfileKey(linked)]: { callsign: "late", avatarUrl: null } });
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1", [accountId(3)]);
    assert.deepEqual(await (await read([linked])).json(), { [traderProfileKey(linked)]: null });
    for (const traders of [Array(5).fill(after), [{ ...after, timestampMs: now + 1 }]]) {
      const invalid = await read(traders);
      assert.equal(invalid.status, 400);
      assert.match(invalid.headers.get("cache-control")!, /no-store/);
    }
  } finally { await fixture.close(); }
});
