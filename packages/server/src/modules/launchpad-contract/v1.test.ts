import assert from "node:assert/strict";
import test from "node:test";

import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { ContractViolation } from "@blast/core/modules/launchpad-contract/decimal.ts";
import { infraProvenanceFixture, poolSummaryFixture } from "../../../test/fixtures/modules/launchpad-contract/fixtures.ts";
import { parseMarketEconomics, parseV1Error, readV1 } from "@blast/core/modules/launchpad-contract/v1.ts";

const ORIGIN = "https://api.blast.test";

function blastInfra(reply: { status: number; body: unknown }): MarketDataDependencies {
  return {
    origin: ORIGIN,
    now: () => 1_790_235_061_630,
    timeoutMs: 1_000,
    statusCacheMs: 0,
    expected: null,
    fetch: async (input: string | URL | Request) => {
      const path = String(input).slice(ORIGIN.length);
      if (path === "/v1/status") return Response.json({ provenance: infraProvenanceFixture() });
      return Response.json(reply.body, { status: reply.status });
    },
  };
}

test("a /v1 summary's economics parse to exact integers, from decimal strings only", () => {
  const economics = parseMarketEconomics(poolSummaryFixture());
  assert.equal(economics.venue, "blast_curve");
  assert.equal(economics.price, "0.002528735632183908045977011494252873");
  assert.equal(economics.marketCap, 2_528_730_574_712n);
  assert.equal(economics.supply, 999_998_000_000_000n);
  assert.deepEqual(economics.inputs, {
    virtualQuote: 1_500_000_000_000n,
    memeReserve: 696_000_000_000_000n,
    quoteReserve: 260_000_000_000n,
    graduationTarget: 3_000_000_000_000n,
    sqrtPriceX64: null,
    memeIsCoinA: null,
    currencySupply: 1_000_000_000_000_000n,
    pendingBurnTotal: 2_000_000_000n,
    balance0x0: 0n,
    memeDecimals: 6n,
    quoteDecimals: 9n,
  });
});

test("a summary that breaks the number contract is refused, never read as zero", () => {
  const summary = poolSummaryFixture();
  for (const [field, value] of [
    ["market_cap", 2_528_730_574_712],
    ["price", "0.0025287356321839080459770114942528730"],
    ["supply", null],
    ["venue", "uniswap"],
  ] as const) {
    assert.throws(() => parseMarketEconomics({ ...summary, [field]: value }), ContractViolation, field);
  }
  const inputs = summary.inputs as Record<string, unknown>;
  for (const [field, value] of [
    ["virtual_quote", 1_500_000_000_000],
    ["currency_supply", "-1"],
    ["sqrt_price_x64", "18446744073709551616"],
    ["meme_is_coin_a", "true"],
  ] as const) {
    assert.throws(
      () => parseMarketEconomics({ ...summary, inputs: { ...inputs, [field]: value } }),
      ContractViolation,
      field,
    );
  }
  assert.throws(() => parseMarketEconomics({ ...summary, inputs: { ...inputs, extra: "1" } }), ContractViolation);
});

test("errors keep blast-infra's code and message", () => {
  assert.deepEqual(parseV1Error({ error: { code: "not_found", message: "no such pool" } }), {
    code: "not_found",
    message: "no such pool",
  });
  assert.throws(() => parseV1Error({ error: { code: "Not Found" } }), ContractViolation);
});

test("the /v1 client validates an answer, keeps its provenance, and turns a broken one into unavailable", async () => {
  const body = { provenance: infraProvenanceFixture(), pool: poolSummaryFixture(), candle: null };
  const pool = (value: unknown) => parseMarketEconomics((value as { pool: unknown }).pool);
  const read = await readV1("market", "/v1/pools/blast_curve/0x1", pool, blastInfra({ status: 200, body }));
  if (read.status !== "fresh" || read.data.kind !== "answer") return assert.fail(JSON.stringify(read));
  assert.equal(read.data.value.marketCap, 2_528_730_574_712n);
  assert.equal(read.provenance.checkpoint, 326_274_009);

  const broken = { ...body, pool: { ...poolSummaryFixture(), market_cap: 1 } };
  const refused = await readV1("market", "/v1/pools/blast_curve/0x1", pool, blastInfra({ status: 200, body: broken }));
  assert.deepEqual(
    { status: refused.status, reason: refused.provenance.reason, data: "data" in refused },
    { status: "unavailable", reason: "contract-violation", data: false },
  );

  const notFound = await readV1(
    "market",
    "/v1/pools/blast_curve/0x2",
    pool,
    blastInfra({ status: 404, body: { error: { code: "not_found", message: "no such pool" } } }),
  );
  if (notFound.status === "unavailable") return assert.fail(JSON.stringify(notFound));
  assert.deepEqual(notFound.data, {
    kind: "refused",
    httpStatus: 404,
    error: { code: "not_found", message: "no such pool" },
  });
});
