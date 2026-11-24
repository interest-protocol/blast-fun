import assert from "node:assert/strict";
import test from "node:test";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { CreatorChain, CreatorTransaction } from "@blast/server/modules/social/creator-earnings/chain.ts";
import {
  CREATOR_EARNINGS_SQL,
  CREATOR_RECEIVED_SQL,
  CREATOR_VESTINGS_SQL,
  readCreatorEarnings,
} from "@blast/server/modules/social/creator-earnings/read.ts";

const id = (digit: string) => `0x${digit.repeat(64)}`;
const OWNER = id("1"),
  SALE = id("2"),
  VAULT = id("3");
const source = {
  vault_id: VAULT,
  presale_id: SALE,
  name: "Creator coin",
  symbol: "COIN",
  icon_url: "",
  decimals: 9,
  quote_symbol: "USDC",
  quote_decimals: 6,
};

function fixture(status: "ready" | "empty" | "unavailable" | "ineligible" = "ready") {
  const queries: Array<{ sql: string; params: unknown }> = [];
  const db = {
    async read(sql: string, params: unknown) {
      queries.push({ sql, params });
      const rows =
        sql === CREATOR_EARNINGS_SQL
          ? [source]
          : sql === CREATOR_RECEIVED_SQL
            ? [{ meme: "9007199254740993", quote: "1234567" }]
            : [];
      return { rows, rowCount: rows.length };
    },
  } as unknown as ReadableDatabase;
  const chain: CreatorChain = {
    async ownedPresales(sender) {
      assert.equal(sender, OWNER);
      return [SALE];
    },
    async transaction(vault, sender, kind) {
      assert.equal(vault, VAULT);
      assert.equal(sender, OWNER);
      if (kind === "claim_residuals" || status === "ineligible") return null;
      return {
        presaleId: SALE,
        kindBytes: new Uint8Array(),
        vault: {
          feeSplit: { routes: [
            { destination: { kind: "Address", address: id("4") }, bps: 3000n },
            { destination: { kind: "Address", address: OWNER }, bps: 7000n },
          ] },
        },
      } as unknown as CreatorTransaction;
    },
    async preview() {
      return status === "unavailable"
        ? null
        : [
            {
              kind: "collect_fees",
              vaultId: VAULT,
              grossMemeAmount: "1000000000",
              grossQuoteAmount: "1000000",
              routeMemeAmounts: ["999999999", status === "empty" ? "0" : "1"],
              routeQuoteAmounts: ["0", status === "empty" ? "0" : "123456"],
            },
          ];
    },
  };
  return { db, chain, queries };
}

test("creator preview uses the wallet's indexed recipient position and exact asset decimals", async () => {
  const { db, chain, queries } = fixture();
  const read = await readCreatorEarnings(db, chain, OWNER, null, 1000);
  assert.equal(read.earnings[0]!.fee_share_bps, 7000);
  assert.deepEqual(read.earnings[0]!.collect, { meme: "0.000000001", quote: "0.123456" });
  assert.deepEqual(read.earnings[0]!.received, { meme: "9007199.254740993", quote: "1.234567" });
  assert.deepEqual(queries.find((q) => q.sql === CREATOR_EARNINGS_SQL)!.params, [
    OWNER,
    [SALE],
    null,
  ]);
  assert.ok(queries.some((q) => q.sql === CREATOR_VESTINGS_SQL));
});

test("empty, unavailable and ineligible fee collections never invent a payable amount", async () => {
  for (const status of ["empty", "unavailable", "ineligible"] as const) {
    const { db, chain } = fixture(status);
    const read = await readCreatorEarnings(db, chain, OWNER, null, 1000);
    if (status === "ineligible") assert.equal(read.earnings.length, 0);
    else {
      assert.equal(read.earnings[0]!.collection_status, status);
      assert.equal(read.earnings[0]!.collect, null);
    }
  }
});

test("a successful event-free collection is empty, while a different vault's event is unavailable", async () => {
  const { db, chain } = fixture();
  const empty = await readCreatorEarnings(
    db,
    { ...chain, preview: async () => [] },
    OWNER,
    null,
    1000,
  );
  assert.equal(empty.earnings[0]!.collection_status, "empty");
  assert.equal(empty.earnings[0]!.collect, null);

  const events = await chain.preview(new Uint8Array(), OWNER);
  const mismatched = await readCreatorEarnings(
    db,
    {
      ...chain,
      preview: async () =>
        events!.map((event) => ({ ...event, vaultId: id("5") })),
    },
    OWNER,
    null,
    1000,
  );
  assert.equal(mismatched.earnings[0]!.collection_status, "unavailable");
  assert.equal(mismatched.earnings[0]!.collect, null);
});
