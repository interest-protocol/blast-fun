import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";

import {
  financialContracts,
  financialContractOverride,
} from "../../../../scripts/financial-contract-schemas.ts";
import { socialClaimInputSchema, socialClaimRequestSchema } from "./claims.ts";
import {
  socialTransferInputSchema,
  socialTransferRequestSchema,
} from "./coins.ts";
import {
  socialCommitInputSchema,
  socialCommitRequestSchema,
} from "./commit.ts";
import {
  launchClaimInputSchema,
  launchClaimRequestSchema,
} from "./launch-claims.ts";
import {
  SOCIAL_TRADE_BASE_COINS,
  socialTradeInputSchema,
  socialTradeQuoteInputSchema,
  socialTradeQuoteRequestSchema,
  socialTradeCoinSchema,
  socialTradeRequestSchema,
} from "./trades.ts";

const address = `0x${"a".repeat(64)}`;
const digest = "1".repeat(32);
const coin = `${address}::coin::COIN`;

for (const [name, schema] of Object.entries(financialContracts)) {
  test(`${name}: generated constraints match the published contract`, () => {
    const published = JSON.parse(
      readFileSync(
        new URL(`./schemas/${name}.schema.json`, import.meta.url),
        "utf8",
      ),
    );
    const generated = {
      ...z.toJSONSchema(schema, {
        target: "draft-2020-12",
        io: "input",
        override: financialContractOverride,
      }),
      $id: `https://blast-v2.invalid/social/contracts/${name}.schema.json`,
    };
    assert.deepEqual(generated, published);
  });
}

test("claim actions require exactly their schedule or vault and exclude simultaneous outcomes", () => {
  for (const kind of [
    "claim_refund",
    "claim_tokens",
    "claim_vesting",
    "collect_fees",
    "claim_residuals",
  ] as const) {
    const body = {
      presale_id: address,
      kind,
      ...(kind === "claim_vesting" ? { schedule_id: address } : {}),
      ...(kind === "collect_fees" || kind === "claim_residuals"
        ? { vault_id: address }
        : {}),
    };
    assert.ok(socialClaimRequestSchema.safeParse(body).success);
    assert.ok(socialClaimInputSchema.safeParse(body).success);
    assert.equal(
      socialClaimRequestSchema.safeParse({
        ...body,
        digest,
        failure: "rejected",
      }).success,
      false,
    );
    assert.equal(
      socialClaimInputSchema.safeParse({ ...body, digest, failure: "rejected" })
        .success,
      false,
    );
    assert.equal(
      socialClaimRequestSchema.safeParse({ ...body, extra: true }).success,
      false,
    );
    const wrongSchedule = {
      ...body,
      schedule_id: body.schedule_id ? undefined : address,
    };
    assert.equal(
      socialClaimRequestSchema.safeParse(wrongSchedule).success,
      false,
    );
    const wrongVault = {
      ...body,
      vault_id: body.vault_id ? undefined : address,
    };
    assert.equal(socialClaimRequestSchema.safeParse(wrongVault).success, false);
  }
});

test("digest provenance retains deferred byte validation and the launch digest prerequisite", () => {
  const transfer = {
    coin_type: coin,
    amount: "1",
    recipient: address,
    transaction_bytes: 7,
  };
  assert.ok(socialTransferInputSchema.safeParse(transfer).success);
  assert.equal(socialTransferRequestSchema.safeParse(transfer).success, false);
  const claim = {
    presale_id: address,
    kind: "claim_tokens",
    transaction_bytes: 7,
  };
  assert.ok(socialClaimInputSchema.safeParse(claim).success);
  assert.equal(socialClaimRequestSchema.safeParse(claim).success, false);
  const launch = {
    launch_id: address,
    kind: "claim_launch_fees",
    transaction_bytes: 7,
  };
  assert.equal(launchClaimInputSchema.safeParse(launch).success, false);
  assert.ok(launchClaimInputSchema.safeParse({ ...launch, digest }).success);
  assert.equal(
    launchClaimRequestSchema.safeParse({ ...launch, digest }).success,
    false,
  );
  assert.equal(
    launchClaimRequestSchema.safeParse({
      launch_id: address,
      kind: "claim_launch_fees",
      digest,
      failure: "rejected",
    }).success,
    false,
  );
});

test("quote execution retains null defaults, side rules and u64 limits", () => {
  const quote = {
    in_coin: SOCIAL_TRADE_BASE_COINS.sui,
    out_coin: coin,
    side: "buy",
    amount_in: "1",
  };
  assert.ok(socialTradeQuoteRequestSchema.safeParse(quote).success);
  assert.ok(
    socialTradeQuoteInputSchema.safeParse({ ...quote, slippage_bps: null })
      .success,
  );
  assert.equal(
    socialTradeQuoteRequestSchema.safeParse({ ...quote, slippage_bps: null })
      .success,
    false,
  );
  assert.equal(
    socialTradeQuoteInputSchema.safeParse({ ...quote, side: "sell" }).success,
    false,
  );
  assert.equal(
    socialTradeQuoteInputSchema.safeParse({ ...quote, out_coin: quote.in_coin })
      .success,
    false,
  );
  for (const schema of [
    socialTradeQuoteInputSchema,
    socialTradeQuoteRequestSchema,
    socialTradeCoinSchema,
  ]) {
    assert.equal(
      schema.safeParse({ ...quote, amount_out: "1" }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ ...quote, amount_in: undefined }).success,
      false,
    );
  }
  assert.ok(
    socialTradeQuoteRequestSchema.safeParse({
      ...quote,
      amount_in: "18446744073709551616",
    }).success,
  );
  assert.equal(
    socialTradeQuoteInputSchema.safeParse({
      ...quote,
      amount_in: "18446744073709551616",
    }).success,
    false,
  );
});

test("commit execution preserves exact bigint leaf values and null swap quotes", () => {
  const body = {
    presale_id: address,
    pay_with: "QUOTE",
    amount: "1",
    allowlist: {
      index: "9007199254740993",
      wallet_cap: "18446744073709551615",
      proof: [],
    },
  };
  const parsed = socialCommitInputSchema.parse({
    ...body,
    swap_quote_id: null,
  });
  assert.equal(parsed.allowlist?.index, 9007199254740993n);
  assert.equal(parsed.allowlist?.walletCap, 18446744073709551615n);
  assert.equal(
    socialCommitRequestSchema.safeParse({ ...body, swap_quote_id: null })
      .success,
    false,
  );
  assert.equal(
    socialCommitInputSchema.safeParse({
      ...body,
      amount: "18446744073709551616",
    }).success,
    false,
  );
});

test("trade input leaves token authentication and matching at their existing boundary", () => {
  const body = {
    quote_id: "",
    amount_in: "0",
    min_out: "0",
    idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  assert.ok(socialTradeInputSchema.safeParse(body).success);
  assert.equal(socialTradeRequestSchema.safeParse(body).success, false);
  assert.equal(
    socialTradeInputSchema.safeParse({ ...body, accept_fee: null }).success,
    false,
  );
});

test("published text bounds count Unicode code points", () => {
  const coinMetadata = {
    coin_type: coin,
    symbol: "🚀".repeat(64),
    name: "🚀".repeat(128),
    decimals: 9,
    icon_url: null,
    usd_price: null,
    presale_id: null,
  };
  assert.ok(socialTradeCoinSchema.safeParse(coinMetadata).success);
  assert.equal(
    socialTradeCoinSchema.safeParse({
      ...coinMetadata,
      symbol: "🚀".repeat(65),
    }).success,
    false,
  );
});
