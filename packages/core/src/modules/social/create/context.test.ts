import assert from "node:assert/strict";
import test from "node:test";
import { CREATE_CONTEXT_MAX_BYTES, decodeCreateContext, encodeCreateContext, type CreatePageContext } from "./context.ts";

const context: CreatePageContext = {
  fees: { raise_bps: 200, token_bps: 100, lp_fee_meme_bps: 1000, lp_fee_quote_bps: 1000, source: "chain" },
  publish: { available: false, reasons: ["creation_policy"] },
  quotes: ["0x2::sui::SUI"], suiPrice: { usd_price: "3.123456789", as_of_ms: 1000 },
  cetusTiers: { "0x2::sui::SUI": [[2, 100]] }, bluefinOptions: { status: "ready", min_tick: -443636, max_tick: 443636 },
};

test("create context preserves exact decimal strings and configured/unavailable states", () => {
  assert.deepEqual(decodeCreateContext(encodeCreateContext(context)), context);
  const disabled: CreatePageContext = { ...context, fees: { ...context.fees, source: "config" }, publish: { available: true }, cetusTiers: null, bluefinOptions: { status: "unavailable" }, suiPrice: null };
  assert.deepEqual(decodeCreateContext(encodeCreateContext(disabled)), disabled);
});

test("create context rejects malformed nested primitives, unknown fields and future envelopes", () => {
  for (const changes of [
    { fees: { ...context.fees, raise_bps: 1.5 } },
    { fees: { ...context.fees, token_bps: -1 } },
    { fees: { ...context.fees, source: "unknown" } },
    { fees: { ...context.fees, privateKey: "never-a-valid-field" } },
    { publish: { available: false, reasons: ["invented"] } },
    { publish: { available: true, reasons: [] } },
    { quotes: [12] }, { suiPrice: { usd_price: 3, as_of_ms: 1000 } },
    { bluefinOptions: { status: "ready", min_tick: "-1", max_tick: 1 } },
    { bluefinOptions: { status: "unavailable", key: "unknown" } },
    { cetusTiers: { quote: [[1, 2, 3]] } }, { cetusTiers: { quote: [[1, "2"]] } },
    { extra: true },
  ]) assert.throws(() => decodeCreateContext(JSON.stringify({ schema: "blast.create-context.v1", context: { ...context, ...changes } })));
  assert.throws(() => decodeCreateContext(JSON.stringify({ schema: "future", context })));
  assert.throws(() => decodeCreateContext(JSON.stringify({ schema: "blast.create-context.v1", context, extra: true })));
});

test("create context bounds raw bytes before parsing and rejects non-JSON producer numbers", () => {
  assert.throws(() => decodeCreateContext(" ".repeat(CREATE_CONTEXT_MAX_BYTES + 1)));
  assert.throws(() => encodeCreateContext({ ...context, fees: { ...context.fees, raise_bps: Number.NaN } }));
});
