import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult, QueryResultRow } from "pg";
import { handleCoinMetadataRequest, readCoinMetadata } from "./coin-metadata.ts";

const COIN = `0x${"a".repeat(64)}::coin::COIN`;
const URL = `https://blast.test/api/v1/market/coins/${encodeURIComponent(COIN)}/metadata`;

test("coin metadata prefers published links, uses chain links for gaps, and omits unsafe URLs", async () => {
  const row = {
    launch_id: null,
    name: "Coin",
    symbol: "COIN",
    description: 'Community coin||{"website":"https://old.example","telegram":"https://t.me/communitycoin","twitter":"javascript:alert(1)"}',
    decimals: 9,
    icon_url: "https://secret@images.example/coin.png",
    tagline: "Coin for the community",
    site: "https://project.example",
    telegram: null,
    x_handle: null,
    docs_url: "docs.project.example/guide",
    audit_url: null,
  };
  const reader = (result: Record<keyof typeof row, string | number | null>) => ({
    async read<Row extends QueryResultRow>(_sql: string, params?: readonly unknown[]) {
      assert.deepEqual(params, [COIN]);
      return { rows: [result] } as unknown as QueryResult<Row>;
    },
  });
  const response = await handleCoinMetadataRequest(new Request(URL), (coin) => readCoinMetadata(reader(row), coin));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    coin_type: COIN,
    name: "Coin",
    symbol: "COIN",
    description: "Community coin",
    decimals: 9,
    icon_url: null,
    tagline: "Coin for the community",
    links: {
      website: "https://project.example",
      x: null,
      telegram: "https://t.me/communitycoin",
      docs: "https://docs.project.example/guide",
      audit: null,
    },
  });

  const published = await readCoinMetadata(reader({
    ...row,
    description: 'Community coin||{"website":"https://old.example","telegram":"https://t.me/oldcoin","twitter":"https://x.com/oldcoin"}',
    site: "invalid site",
    x_handle: "coinproject",
    telegram: "coinproject",
    audit_url: "https://docs.project.example/audit",
  }), COIN);
  assert.deepEqual(published?.links, {
    website: "https://old.example/",
    x: "https://x.com/coinproject",
    telegram: "https://t.me/coinproject",
    docs: "https://docs.project.example/guide",
    audit: "https://docs.project.example/audit",
  });
});

test("coin metadata distinguishes bad parameters, indexing gaps, and source failures", async () => {
  const unexpectedRead = async () => assert.fail("Invalid parameters must not read metadata");
  for (const invalid of [
    URL.replace(encodeURIComponent(COIN), "%xx"),
    URL.replace(encodeURIComponent(COIN), "0x2%3A%3Asui%3A%3ASUI"),
    URL.replace("/metadata", "/private"),
    URL + "?wallet=a",
  ]) {
    const response = await handleCoinMetadataRequest(new Request(invalid), unexpectedRead);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_parameter");
  }
  const absent = await handleCoinMetadataRequest(new Request(URL), async () => null);
  const unavailable = await handleCoinMetadataRequest(new Request(URL), async () => {
    throw new Error("private infrastructure failure");
  });

  assert.equal(absent.status, 404);
  assert.equal((await absent.json()).error.code, "not_found");
  assert.equal(unavailable.status, 503);
  const errorBody = await unavailable.text();
  assert.equal(JSON.parse(errorBody).error.code, "unavailable");
  assert.ok(!errorBody.includes("private infrastructure failure"));
  assert.ok(unavailable.headers.has("retry-after"));
});
