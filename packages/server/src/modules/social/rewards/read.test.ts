import assert from "node:assert/strict";
import test from "node:test";

import { socialRewardsPath } from "@blast/core/modules/social/contracts/rewards.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import {
  decodeRewardsCursor,
  encodeRewardsCursor,
  parseRewardsQuery,
  readRewardsPage,
  REWARD_COINS_SQL,
  REWARD_PAYOUTS_SQL,
  rewardCoinOf,
  rewardPayoutOf,
} from "@blast/server/modules/social/rewards/read.ts";

/** OA-45: the rewards read's query, cursor and row mapping, without a database. */

const SALE = `0x${"a".repeat(64)}`;
const WALLET = `0x${"1".repeat(64)}`;
const RELAYER = `0x${"9".repeat(64)}`;
const url = (search: string) =>
  new URL(`https://blast.fun/api/social/me/rewards${search}`);
const refused = (parameter: string) => (error: unknown) =>
  error instanceof SocialRouteError &&
  error.code === "invalid_parameter" &&
  error.extra.parameter === parameter;

test("OA-45: limit, cursor and presale parse once each; anything malformed is invalid_parameter", () => {
  assert.deepEqual(parseRewardsQuery(url("")), {
    limit: 20,
    cursor: null,
    presaleId: null,
  });
  const cursor = encodeRewardsCursor({
    checkpoint: "326274009",
    txSlot: "3",
    eventSlot: "4294967295",
  });
  assert.deepEqual(
    parseRewardsQuery(url(`?limit=5&presale=${SALE}&cursor=${cursor}&other=1`)),
    {
      limit: 5,
      cursor: { checkpoint: "326274009", txSlot: "3", eventSlot: "4294967295" },
      presaleId: SALE,
    },
  );
  for (const bad of ["?limit=0", "?limit=51", "?limit=x", "?limit=1&limit=2"])
    assert.throws(() => parseRewardsQuery(url(bad)), refused("limit"), bad);
  for (const bad of [
    "?presale=0x1",
    `?presale=${SALE.toUpperCase()}`,
    `?presale=${SALE}&presale=${SALE}`,
  ])
    assert.throws(() => parseRewardsQuery(url(bad)), refused("presale"), bad);
  const enc = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const bad of [
    "x",
    enc(["1", "2"]),
    enc([1, 2, 3]),
    enc(["1", "4294967296", "0"]),
    enc(["01", "0", "0"]),
    enc(["9223372036854775808", "0", "0"]),
    "a".repeat(201),
  ]) {
    assert.throws(() => decodeRewardsCursor(bad), refused("cursor"), bad);
  }
});

test("OA-45: the path a page is read from", () => {
  assert.equal(socialRewardsPath(), "/api/social/me/rewards");
  assert.equal(
    socialRewardsPath({ limit: 5 }),
    "/api/social/me/rewards?limit=5",
  );
  assert.equal(
    socialRewardsPath({ presale: SALE, limit: 10, cursor: "abc" }),
    `/api/social/me/rewards?presale=${SALE}&limit=10&cursor=abc`,
  );
});

test("OA-45: the reads go through chain_read_v1 views only, keyset on the chain position, never OFFSET", () => {
  assert.match(
    REWARD_PAYOUTS_SQL,
    /FROM chain_read_v1\.vault_reward_payouts p[\s\S]+WHERE p\.beneficiary = ANY\(\$1::text\[\]\)/,
  );
  assert.match(
    REWARD_PAYOUTS_SQL,
    /\(p\.checkpoint, p\.tx_slot, p\.event_slot\) < \(\$3::bigint, \$4::bigint, \$5::bigint\)/,
  );
  assert.match(
    REWARD_PAYOUTS_SQL,
    /ORDER BY p\.checkpoint DESC, p\.tx_slot DESC, p\.event_slot DESC\s+LIMIT \$6/,
  );
  assert.doesNotMatch(REWARD_PAYOUTS_SQL + REWARD_COINS_SQL, /OFFSET/i);
  // The canonical vault rounds include closed rounds.
  assert.match(
    REWARD_COINS_SQL,
    /FROM chain_read_v1\.vault_rounds r/,
  );
  assert.doesNotMatch(
    REWARD_COINS_SQL,
    /presale_reward_rounds|r\.closed/,
  );
  assert.match(
    REWARD_COINS_SQL,
    /FROM chain_read_v1\.vaults v/,
  );
});

test("OA-45: a payout says who sent it; the summary's owed amounts split by delivery mark", () => {
  const row = {
    presale_id: SALE,
    round_id: `0x${"b".repeat(64)}`,
    round_number: "11",
    meme_amount: "1254000000000",
    quote_amount: "2100000",
    digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    timestamp_ms: "1791028800000",
    relayed_by: RELAYER,
    checkpoint: "1",
    tx_slot: "0",
    event_slot: "0",
  };
  const own = new Set([WALLET]);
  assert.deepEqual(rewardPayoutOf(row, own), {
    presale_id: SALE,
    round_id: row.round_id,
    round_number: "11",
    meme_amount: "1254000000000",
    quote_amount: "2100000",
    digest: row.digest,
    timestamp_ms: 1791028800000,
    relayed_by: RELAYER,
    self_claimed: false,
  });
  assert.equal(
    rewardPayoutOf({ ...row, relayed_by: WALLET }, own).self_claimed,
    true,
  );
  const coin = {
    presale_id: SALE,
    name: "Kestrel",
    symbol: "KSTL",
    icon_url: "https://i/k.png",
    sale_decimals: 9,
    quote_type: "0x2::sui::SUI",
    quote_symbol: "SUI",
    quote_decimals: 9,
    rounds: 12,
    payouts: 12,
    received_meme: "16206000000000",
    received_quote: "38430000",
    last_payout_ms: "1791028800000",
  };
  assert.equal(rewardCoinOf(coin).waiting, null);
  const waiting = { next: { meme: "410", quote: "0" }, unpayable: null };
  assert.deepEqual(rewardCoinOf(coin, waiting).waiting, waiting);
  assert.equal(
    rewardCoinOf({ ...coin, last_payout_ms: null }).last_payout_ms,
    null,
  );
  // A vault coin's metadata is whatever its publisher wrote: cut to the wire's bounds, an inline logo dropped.
  const odd = rewardCoinOf({ ...coin, name: "🐳".repeat(500), symbol: "🐳".repeat(500), icon_url: `data:image/png;base64,${"A".repeat(20_000)}` });
  assert.deepEqual([odd.name, odd.symbol, odd.icon_url], ["🐳".repeat(200), "🐳".repeat(64), ""]);
});

test("OA-45: an account without wallets reads nothing", async () => {
  const database = {
    read: async () => assert.fail("no read without wallets"),
  } as never;
  const context = {
    nowMs: 0,
    network: "mainnet",
    waiting: async () => assert.fail("no waiting read without wallets"),
  };
  assert.deepEqual(
    await readRewardsPage(
      database,
      [],
      { limit: 5, cursor: null, presaleId: null },
      context,
    ),
    { coins: [], payouts: [], next_cursor: null },
  );
  assert.deepEqual(
    await readRewardsPage(
      database,
      [],
      { limit: 5, cursor: null, presaleId: SALE },
      context,
    ),
    { coins: null, payouts: [], next_cursor: null },
  );
});

const emptyDatabase = {
  async read() {
    return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
  },
};

test("waiting rewards read fifty wallets per batch with at most two batches in flight", async () => {
  const wallets = Array.from(
    { length: 121 },
    (_, index) => `0x${String(index + 1).padStart(64, "0")}`,
  );
  const batches: (readonly string[])[] = [];
  let active = 0;
  let maximum = 0;
  await readRewardsPage(emptyDatabase, wallets, parseRewardsQuery(url("")), {
    nowMs: 0,
    network: "mainnet",
    async waiting(batch) {
      batches.push(batch);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return [];
    },
  });
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [50, 50, 21],
  );
  assert.deepEqual(batches.flat(), wallets);
  assert.equal(maximum, 2);
  assert.equal(active, 0);
});

test("a failed waiting batch stops queued reads and observes the other in-flight batch", async () => {
  let calls = 0;
  let finished = false;
  const page = await readRewardsPage(
    emptyDatabase,
    Array(151).fill(WALLET),
    parseRewardsQuery(url("")),
    {
      nowMs: 0,
      network: "mainnet",
      async waiting() {
        calls += 1;
        if (calls === 1) throw new Error("reader unavailable");
        await new Promise<void>((resolve) => setImmediate(resolve));
        finished = true;
        throw new Error("second reader unavailable");
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(finished, true);
  assert.deepEqual(page, { coins: [], payouts: [], next_cursor: null });
});
