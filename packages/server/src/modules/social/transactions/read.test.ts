import assert from "node:assert/strict";
import test from "node:test";

import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { decodeTransactionsCursor, encodeTransactionsCursor, parseTransactionsQuery, TRANSACTIONS_FIRST_PAGE_SQL, TRANSACTIONS_NEXT_PAGE_SQL } from "@blast/server/modules/social/transactions/read.ts";

/** Social feed R3-27-AC-4: the list's query parameters and its keyset statements, without a database. */

const TX = "0b8f6a52-6c1e-4d0b-9a57-3f2c1d4e5a6b";
const url = (query: string) => new URL(`https://blast.fun/api/social/me/transactions${query}`);
const invalid = (parameter: string) => (error: unknown) =>
  error instanceof SocialRouteError && error.code === "invalid_parameter" && error.extra.parameter === parameter;

test("R3-27-AC-4: limit is 1 to 50, 30 by default; a cursor round-trips; anything else is invalid_parameter", () => {
  assert.deepEqual(parseTransactionsQuery(url("")), { limit: 30, cursor: null });
  assert.deepEqual(parseTransactionsQuery(url("?limit=1&other=x")), { limit: 1, cursor: null });
  assert.deepEqual(parseTransactionsQuery(url("?limit=50")), { limit: 50, cursor: null });
  const cursor = { createdAtMs: "1790235061218", txId: TX };
  assert.deepEqual(decodeTransactionsCursor(encodeTransactionsCursor(cursor)), cursor);
  assert.deepEqual(parseTransactionsQuery(url(`?cursor=${encodeTransactionsCursor(cursor)}`)), { limit: 30, cursor });
  for (const query of ["?limit=0", "?limit=51", "?limit=05", "?limit=-1", "?limit=1.5", "?limit=1&limit=2"]) {
    assert.throws(() => parseTransactionsQuery(url(query)), invalid("limit"), query);
  }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const raw of [
    "x",
    encode(["1790235061218"]),
    encode([1790235061218, TX]),
    encode(["0", TX]),
    encode(["9223372036854775808", TX]),
    encode(["1790235061218", TX.toUpperCase()]),
    encode(["1790235061218", TX, "extra"]),
    "a".repeat(201),
  ]) {
    assert.throws(() => parseTransactionsQuery(url(`?cursor=${raw}`)), invalid("cursor"), raw);
  }
  assert.throws(() => parseTransactionsQuery(url(`?cursor=${encode(["1", TX])}&cursor=${encode(["2", TX])}`)), invalid("cursor"));
});

test("R3-27-AC-4: the page statements are keyset on (created_at_ms, tx_id) in the list index's order, with no OFFSET", () => {
  for (const sql of [TRANSACTIONS_FIRST_PAGE_SQL, TRANSACTIONS_NEXT_PAGE_SQL]) {
    assert.doesNotMatch(sql, /\bOFFSET\b/i);
    assert.match(sql, /ORDER BY s\.created_at_ms DESC, s\.tx_id\s+LIMIT \$\d/);
    assert.ok(!sql.includes(";"), "one statement");
  }
  assert.match(TRANSACTIONS_NEXT_PAGE_SQL, /s\.created_at_ms <= \$2::bigint AND \(s\.created_at_ms < \$2::bigint OR s\.tx_id > \$3::uuid\)/);
  assert.doesNotMatch(TRANSACTIONS_FIRST_PAGE_SQL, /\$3/);
});
