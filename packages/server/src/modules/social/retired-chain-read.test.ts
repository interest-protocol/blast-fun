import assert from "node:assert/strict";
import test from "node:test";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";

function unreadable<T extends object>(): T {
  return new Proxy({} as T, {
    get(_target, name) {
      assert.fail(`Unexpected I/O access: ${String(name)}`);
    },
  });
}

const database = unreadable<ReadableDatabase>();
const query = { limit: 20, cursor: null, presaleId: null };
const context = {
  nowMs: 0,
  network: "mainnet",
  waiting: async () => assert.fail("Unexpected waiting rewards read"),
};

test("creator earnings and rewards use the unified vault views", async () => {
  const [creator, rewards] = await Promise.all([
    import("./creator-earnings/read.ts"),
    import("./rewards/read.ts"),
  ]);
  for (const [sql, view] of [
    [creator.CREATOR_EARNINGS_SQL, "vaults"],
    [creator.CREATOR_RECEIVED_SQL, "vault_fee_collections"],
    [rewards.REWARD_PAYOUTS_SQL, "vault_reward_payouts"],
    [rewards.REWARD_COINS_SQL, "vault_rounds"],
  ] as const) {
    assertChainReadThroughViews(sql);
    assert.ok(sql.includes(`FROM chain_read_v1.${view} `), `Expected to read ${view}`);
  }
});

test("empty-wallet rewards preserves its empty response without I/O", async () => {
  const { readRewardsPage } = await import("./rewards/read.ts");
  assert.deepEqual(await readRewardsPage(database, [], query, context), {
    coins: [], payouts: [], next_cursor: null,
  });
  assert.deepEqual(await readRewardsPage(database, [], { ...query, presaleId: "0x1" }, context), {
    coins: null, payouts: [], next_cursor: null,
  });
});
