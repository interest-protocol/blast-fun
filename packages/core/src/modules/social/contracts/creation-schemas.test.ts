import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import Ajv2020 from "ajv/dist/2020.js";

import { createSocialValidator, type SocialSchemaName } from "./validate.ts";
import { socialIntentRequestSchema, socialIntentRecordedSchema } from "./intents.ts";
import { socialDepositRequestSchema, socialDepositSchema, socialDepositBridgeSchema } from "./deposits.ts";
import { socialBridgeWithdrawRequestSchema, socialBridgeWithdrawalSchema, socialBridgeWithdrawQuoteSchema } from "./bridge-withdraw.ts";
import { saleMetadataRequestSchema, socialSaleMetadataSchema, socialSaleMetadataResponseSchema } from "./sales.ts";
import { CREATE_QUOTES, createDraftSchema, createDraftRequestSchema, createDraftResponseSchema, createDraftPageSchema } from "./create.ts";
import { blankDraft, CREATE_DEFAULT_FEE_POLICY } from "../create/model.ts";
import { blastWorkspaceRequestSchema, blastWorkspaceResponseSchema, blastWorkspaceAcknowledgementSchema, blastWorkspaceSetupSchema } from "./blast-workspace.ts";
import { emptyWorkspace } from "../blast-workspace/setup.ts";

const id = "11111111-1111-4111-8111-111111111111";
const address = `0x${"a".repeat(64)}`;
const metadata = { tagline: "😀".repeat(80), site: null, x_handle: null, telegram: null, docs_url: null, audit_url: null, cover: null, launch_at_ms: null };
const deposit = { request_id: id, source: "base", amount: "1", state: "submitted", digest: null, failure_code: null, tx_hash: null, transfer: null, plan: null, created_at_ms: 1, settled_at_ms: null };
const withdrawal = { withdrawal_id: id, status: "built", destination: "base", recipient: `0x${"a".repeat(40)}`, amount: "2", max_fee: "1", receive: "1", network_fee: null, reservation_id: null, transaction_bytes: null, digest: null, expires_at_ms: null, failure_code: null, destination_tx_hash: null, created_at_ms: 1, burned_at_ms: null, delivered_at_ms: null };
const published = createSocialValidator();

function parity(name: SocialSchemaName, schema: z.ZodType, good: unknown, bad: readonly unknown[]) {
  test(`${name}: published, generated and runtime validators agree`, () => {
    const generated = new Ajv2020({ strict: false }).compile(z.toJSONSchema(schema, { io: "input" }));
    for (const [value, expected] of [[good, true], ...bad.map((value) => [value, false])] as const) {
      assert.equal(published.validate(name, value).valid, expected, `published ${JSON.stringify(value)}`);
      assert.equal(schema.safeParse(value).success, expected, `runtime ${JSON.stringify(value)}`);
      assert.equal(generated(value), expected, `generated ${JSON.stringify(value)}`);
    }
  });
}

parity("intent-request", socialIntentRequestSchema, { action: "commit", presale_id: address, tx_digest: "A".repeat(32), why: "😀".repeat(1120) }, [
  { action: "buy", presale_id: address, tx_digest: "A".repeat(32) },
  { action: "commit", presale_id: address, tx_digest: "A".repeat(32), quote_amount: "1" },
]);
parity("intent-response", socialIntentRecordedSchema, { status: "recorded", why: "why_invalid" }, [{ status: "recorded", why: "unknown" }]);
parity("deposit-request", socialDepositRequestSchema, { source: "base", amount: "1" }, [
  { source: "base", amount: "0" },
  { source: "base", amount: "1", tx_hash: `0x${"a".repeat(64)}`, failure: "rejected" },
]);
parity("deposit-response", socialDepositSchema, deposit, [{ ...deposit, created_at_ms: 0.5 }, { ...deposit, transfer: {} }]);
parity("deposit-bridge-response", socialDepositBridgeSchema, { available: true }, [{ available: true, extra: true }]);
parity("bridge-withdraw-request", socialBridgeWithdrawRequestSchema, { idempotency_key: id, destination: "base", recipient: withdrawal.recipient, amount: "2", max_fee: "1" }, [{ idempotency_key: id, destination: "base", recipient: "invalid", amount: "2", max_fee: "1" }]);
parity("bridge-withdraw-response", socialBridgeWithdrawalSchema, withdrawal, [{ ...withdrawal, failure_code: "rejected" }]);
parity("bridge-withdraw-quote-response", socialBridgeWithdrawQuoteSchema, {
  destinations: ["base", "arbitrum", "ethereum", "solana"].map((destination) => ({ destination, available: false, unavailable_reason: "not_live", fee_bps: null, forward_fee: null })),
  network_fee: { payer: "blast", label: "Paid by Blast" }, as_of_ms: 0,
}, [{ destinations: [], network_fee: { payer: "blast", label: "Paid by Blast" }, as_of_ms: 0 }]);
parity("sale-metadata-request", saleMetadataRequestSchema, { tagline: "😀".repeat(1024) }, [{ tagline: "😀".repeat(1025) }, { target: 1 }]);
parity("sale-metadata", socialSaleMetadataSchema, metadata, [{ ...metadata, cover: { url: "https://example.com/image", width: 1, height: 1, source: { width: 8193, height: 1 } } }]);
parity("sale-metadata-response", socialSaleMetadataResponseSchema, { presale_id: address, metadata, editable: false }, [{ presale_id: address, metadata }]);
parity("create-draft", createDraftSchema, { ...blankDraft(), tagline: "😀".repeat(120) }, [
  { ...blankDraft(), supply: 0.5 },
  { ...blankDraft(), tagline: "😀".repeat(121) },
]);
test("create-draft: every listed raise coin is a valid quote_type", () => {
  for (const quote of CREATE_QUOTES) assert.ok(createDraftSchema.shape.quote_type.safeParse(quote.quote_type).success, quote.symbol);
});
parity("create-draft-request", createDraftRequestSchema, { version: 0, draft: blankDraft() }, [{ version: -1, draft: blankDraft() }]);
parity("create-draft-page", createDraftPageSchema, { items: [], next_cursor: null }, [{ items: [], next_cursor: "invalid" }]);
parity("blast-workspace-request", blastWorkspaceRequestSchema, { initialize_if_absent: true, writer_id: "writer", sequence: 1, workspace: emptyWorkspace() }, [{ initialize_if_absent: true, writer_id: "writer", sequence: 0, workspace: emptyWorkspace() }]);
parity("blast-workspace-response", blastWorkspaceResponseSchema, { account_id: id, revision: "0", saved_at_ms: null, workspace: null }, [{ account_id: id, revision: "0", saved_at_ms: 0, workspace: null }]);
parity("blast-workspace-acknowledgement", blastWorkspaceAcknowledgementSchema, { account_id: id, revision: "1", saved_at_ms: 1, sequence: 1 }, [{ account_id: id, revision: "0", saved_at_ms: 1, sequence: 1 }]);

parity("create-draft-response", createDraftResponseSchema, {
  draft_id: id, version: 1, created_at_ms: 0, updated_at_ms: 0, draft: blankDraft(),
  logo_url: null, cover: null, published_presale_id: null, allowlist: null, issues: [],
  fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: CREATE_QUOTES.map((quote) => quote.quote_type), sui_price: null,
}, [{ draft_id: id, version: 1 }]);
parity("blast-workspace-setup", blastWorkspaceSetupSchema, emptyWorkspace(), [{ ...emptyWorkspace(), schema_version: 2 }]);
