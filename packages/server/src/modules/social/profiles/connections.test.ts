import assert from "node:assert/strict";
import test from "node:test";
import { isSocialConnectionCounts, isSocialConnections } from "@blast/core/modules/social/contracts/connections.ts";
import { parseConnectionQuery } from "@blast/server/modules/social/profiles/connections.ts";

const url = (query: string) => new URL(`https://blast.fun/api/social/profiles/kai/connections?${query}`);
const position = ["kai", "followers", "nova", "2026-10-14T12:00:00.123456Z", "00000000-0000-4000-8000-000000000123"];
const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

test("connections query validates tab, bounds, repeated parameters and scoped microsecond cursors", () => {
  assert.deepEqual(parseConnectionQuery(url(""), "kai"), { tab: null, q: "", limit: 20, before: null });
  assert.deepEqual(parseConnectionQuery(url(`tab=followers&q=%40Nova&limit=1&cursor=${cursor(position)}`), "kai"), {
    tab: "followers", q: "nova", limit: 1, before: position.slice(3),
  });
  for (const query of ["tab=other", "limit=0", "limit=51", "limit=2x", "limit=1&limit=2", "tab=followers&tab=followers", "q=x", "tab=following&cursor=garbage", `tab=followers&q=${"x".repeat(81)}`,
    `tab=following&q=nova&cursor=${cursor(position)}`, `tab=followers&q=other&cursor=${cursor(position)}`,
    `tab=followers&q=nova&cursor=${cursor(["elsewhere", ...position.slice(1)])}`,
    `tab=followers&q=nova&cursor=${cursor([...position.slice(0, 3), "2026-02-30T12:00:00.123456Z", position[4]])}`]) {
    assert.throws(() => parseConnectionQuery(url(query), "kai"), { code: "invalid_parameter" }, query);
  }
});

test("counts and pages validate their separate response shapes", () => {
  const counts = { followers: 0, following: 1 };
  assert.equal(isSocialConnectionCounts(counts), true);
  for (const value of [{ ...counts, followers: -1 }, { ...counts, following: "1" }, { ...counts, followers: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal(isSocialConnectionCounts(value), false);
  const page = { next_cursor: null, accounts: [{ callsign: "nova", display_name: null, avatar_url: null, verified: false, private: false }] };
  assert.equal(isSocialConnections(page), true);
  assert.equal(isSocialConnections(counts), false);
  assert.equal(isSocialConnectionCounts(page), false);
  for (const value of [{ ...page, accounts: [{ ...page.accounts[0], callsign: "bad/path" }] }, { ...page, next_cursor: 1 }]) assert.equal(isSocialConnections(value), false);
});
