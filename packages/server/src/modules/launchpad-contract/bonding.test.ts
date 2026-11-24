import assert from "node:assert/strict";
import test from "node:test";
import {
  bondingCursor,
  bondingPath,
  bondingPosition,
  parseBondingPage,
} from "@blast/core/modules/launchpad-contract/bonding.ts";
import {
  encodeCursor,
  CursorError,
} from "@blast/core/modules/launchpad-contract/cursor.ts";
import { parseLaunchSummary } from "@blast/core/modules/launchpad-contract/discovery.ts";
import { normalizeBondingSearch } from "@blast/core/modules/launchpad-discovery/bonding.ts";
import { launchSummaryFixture } from "../../../test/fixtures/modules/launchpad-contract/fixtures.ts";
const selection = { stage: "bonding", sort: "progress", q: "" } as const;
function row(id: number, reserve: string, target: string) {
  const value = launchSummaryFixture();
  value.pool_id = `0x${id.toString(16).padStart(64, "0")}`;
  value.pool_key = `blast_curve:${value.pool_id}`;
  value.created_cursor = `${id}:0:0:0`;
  value.created_at_ms = id;
  value.inputs = {
    ...(value.inputs as object),
    quote_reserve: reserve,
    graduation_target: target,
  };
  return value;
}
test("closest uses percentage across quote scales and preserves distinctions below a displayed basis point", () => {
  const high = row(1, "92", "100");
  const low = row(2, "90000000000", "100000000000");
  assert.equal(
    parseBondingPage(selection, { pools: [high, low], next_cursor: null })
      .launches.length,
    2,
  );
  assert.throws(
    () =>
      parseBondingPage(selection, { pools: [low, high], next_cursor: null }),
    /order/,
  );
  const denominator = 2n ** 64n - 1n;
  const a = bondingPosition(
    selection,
    parseLaunchSummary(row(1, String(denominator - 1n), String(denominator))),
  )!;
  const b = bondingPosition(
    selection,
    parseLaunchSummary(
      row(2, String(denominator - 2n), String(denominator - 1n)),
    ),
  )!;
  assert.ok(BigInt(a.key[0]) > BigInt(b.key[0]));
});
test("cursor is the last complete position and cannot cross search, stage, order or creator", () => {
  const raw = row(1, "92", "100");
  const place = bondingPosition(selection, parseLaunchSummary(raw))!;
  const token = encodeCursor(bondingCursor(selection), place.key, place.tie);
  assert.equal(
    parseBondingPage(selection, { pools: [raw], next_cursor: token })
      .nextCursor,
    token,
  );
  assert.throws(
    () => parseBondingPage(selection, { pools: [], next_cursor: token }),
    /last position/,
  );
  for (const changed of [
    { ...selection, q: "frog" },
    { ...selection, stage: "graduated", sort: "newest" } as const,
    { ...selection, sort: "newest" } as const,
    {
      ...selection,
      creator: `0x${"a1".repeat(32)}`,
      accountCommitment: "07".repeat(32),
    },
    { ...selection, creator: `0x${"a1".repeat(32)}` },
  ])
    assert.throws(() => bondingPath(changed, { cursor: token }), CursorError);
  assert.match(bondingPath(selection, { cursor: token }), /^\/v1\/bonding\?/);
});
test("missing progress inputs and unknown page state fail closed; newest includes opening-round curves", () => {
  assert.throws(
    () =>
      parseBondingPage(selection, {
        pools: [row(1, "0", "0")],
        next_cursor: null,
      }),
    /outside/,
  );
  assert.throws(
    () => parseBondingPage(selection, { pools: [], next_cursor: undefined }),
    /token/,
  );
  const opening = { ...row(1, "0", "100"), lifecycle: "opening_round" };
  assert.equal(
    parseBondingPage(
      { ...selection, sort: "newest" },
      { pools: [opening], next_cursor: null },
    ).launches.length,
    1,
  );
});
test("search normalizes symbols, unicode and whitespace and bounds UTF-8; invalid limits are refused", () => {
  assert.equal(normalizeBondingSearch("  $ＦＲＯＧ   coin  "), "frog coin");
  assert.equal(normalizeBondingSearch("🪙".repeat(33)), null);
  for (const limit of ["0", "101", "-1", "1.5", "1000000000"])
    assert.throws(() => bondingPath(selection, { limit }), CursorError);
});

test("account commitment is only admitted beside a canonical wallet and binds its cursor", () => {
  const owner = {
    ...selection,
    creator: `0x${"a1".repeat(32)}`,
    accountCommitment: "07".repeat(32),
  };
  const token = encodeCursor(
    bondingCursor(owner),
    ["1"],
    ["00000000000000000001", "00000000000000000000", "00000000000000000000"],
  );
  assert.throws(
    () =>
      bondingPath(
        { ...owner, accountCommitment: "08".repeat(32) },
        { cursor: token },
      ),
    CursorError,
  );
  assert.throws(
    () =>
      bondingPath(
        { ...selection, accountCommitment: owner.accountCommitment },
        {},
      ),
    CursorError,
  );
});
