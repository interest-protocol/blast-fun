import assert from "node:assert/strict";
import test from "node:test";

import { fixtureDetail } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { saleAccess } from "./sale-access";

const WALLET = `0x${"ab12".repeat(15)}cd34`;
// Sable: a USDC sale at $0.001 a token, $25 to $20,000 a wallet, here behind a 1,240-wallet whitelist.
const whitelisted = () => {
  const base = fixtureDetail("sabl");
  return { ...base, presale: { ...base.presale, allowlisted: true }, terms: { ...base.terms!, eligibility: { kind: "allowlisted" as const, wallets: 1240 } } };
};

test("a sale with no whitelist is open to everyone at the per-wallet range, with no viewer reads", () => {
  assert.deepEqual(saleAccess(fixtureDetail("sabl"), { viewer: "pending", wallet: undefined, leaf: undefined }), {
    kind: "open",
    range: "25\u00a0USDC to 20,000\u00a0USDC",
    tokens: "≈\u00a025,000 to 20M\u00a0SABL",
  });
});

test("a listed wallet can buy up to its leaf's cap, priced in tokens", () => {
  // 500 USDC (500,000,000 atoms at 6 decimals) / $0.001 = 500,000 tokens.
  const leaf = { status: "ok", httpStatus: 200, body: { index: "3", wallet_cap: "500000000", proof: [] } } as const;
  assert.deepEqual(saleAccess(whitelisted(), { viewer: "signed_in", wallet: WALLET, leaf }), {
    kind: "listed",
    wallet: "0xab12…cd34",
    cap: "500\u00a0USDC",
    tokens: "≈\u00a0500,000\u00a0SABL at $0.001 each",
  });
});

test("a SUI sale's cap and token count run in SUI, never through the dollar price", () => {
  // 500 SUI (500,000,000,000 atoms at 9 decimals) / 0.001 SUI = 500,000 tokens; the $0.004 price would give 125,000.
  const base = whitelisted();
  const sui = fixtureDetail("sabl", { asSui: true }).presale;
  const detail = { ...base, presale: { ...sui, allowlisted: true, presale_price_quote: "0.001", presale_price_usd: "0.004" } };
  const leaf = { status: "ok", httpStatus: 200, body: { index: "3", wallet_cap: "500000000000", proof: [] } } as const;
  assert.deepEqual(saleAccess(detail, { viewer: "signed_in", wallet: WALLET, leaf }), {
    kind: "listed",
    wallet: "0xab12…cd34",
    cap: "500\u00a0SUI",
    tokens: "≈\u00a0500,000\u00a0SABL at 0.001\u00a0SUI each",
  });
  // Open, 25 to 20,000 SUI a wallet: 25,000 to 20M tokens, whatever the dollar figures say.
  const open = { ...detail, presale: { ...detail.presale, allowlisted: false, min_commitment_usd: "100.00", wallet_cap_usd: "80000.00" } };
  assert.deepEqual(saleAccess(open, { viewer: "signed_in", wallet: WALLET, leaf: undefined }), { kind: "open", range: "25\u00a0SUI to 20,000\u00a0SUI", tokens: "≈\u00a025,000 to 20M\u00a0SABL" });
});

test("the whitelist answer follows the viewer and the proof read", () => {
  const detail = whitelisted();
  assert.deepEqual(saleAccess(detail, { viewer: "signed_out", wallet: undefined, leaf: undefined }), { kind: "signed_out", wallets: 1240, publicFrom: null });
  assert.deepEqual(saleAccess(detail, { viewer: "pending", wallet: undefined, leaf: undefined }), { kind: "checking" });
  assert.deepEqual(saleAccess(detail, { viewer: "signed_in", wallet: WALLET, leaf: undefined }), { kind: "checking" });
  assert.deepEqual(
    saleAccess(detail, { viewer: "signed_in", wallet: WALLET, leaf: { status: "refused", code: "not_eligible", retryAfterSeconds: null } }),
    { kind: "not_listed", wallet: "0xab12…cd34", publicFrom: null },
  );
  // A public window opens the sale to every wallet from its time: not listed still means "you can buy then".
  const later = { ...detail, terms: { ...detail.terms, public_buy: { from_ms: 1_800_000_000_000, min_atoms: "25000000", hard_cap_from_ms: null } } };
  assert.deepEqual(saleAccess(later, { viewer: "signed_out", wallet: undefined, leaf: undefined }), { kind: "signed_out", wallets: 1240, publicFrom: 1_800_000_000_000 });
  assert.deepEqual(
    saleAccess(later, { viewer: "signed_in", wallet: WALLET, leaf: { status: "refused", code: "not_eligible", retryAfterSeconds: null } }),
    { kind: "not_listed", wallet: "0xab12…cd34", publicFrom: 1_800_000_000_000 },
  );
});

test("a failed wallet or proof read says the list can't be checked, never 'not listed'", () => {
  const detail = whitelisted();
  assert.deepEqual(saleAccess(detail, { viewer: "signed_in", wallet: { failed: "service_unavailable" }, leaf: undefined }), { kind: "unknown", wallet: null, code: "service_unavailable" });
  assert.deepEqual(saleAccess(detail, { viewer: "signed_in", wallet: WALLET, leaf: { status: "error", code: "network_error" } }), { kind: "unknown", wallet: "0xab12…cd34", code: "network_error" });
  assert.deepEqual(
    saleAccess(detail, { viewer: "signed_in", wallet: WALLET, leaf: { status: "refused", code: "allowlist_unknown", retryAfterSeconds: null } }),
    { kind: "unknown", wallet: "0xab12…cd34", code: "allowlist_unknown" },
  );
});
