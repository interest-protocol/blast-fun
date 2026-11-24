import assert from "node:assert/strict";
import test from "node:test";

import { socialCallsignAvailabilitySchema, socialCreateAccountRequestSchema } from "./accounts.ts";
import { socialMeResponseSchema } from "./me.ts";
import { socialProfileCallsSchema, socialProfileEditRequestSchema, socialProfileEditSchema, socialProfileMutualsSchema } from "./profile-page.ts";
import { socialPnlSchema } from "./pnl.ts";
import { createSocialValidator, type SocialSchemaName } from "./validate.ts";

const published = createSocialValidator();

function parity(name: SocialSchemaName, schema: { safeParse(value: unknown): { success: boolean } }, cases: readonly unknown[]) {
  for (const value of cases) {
    assert.equal(schema.safeParse(value).success, published.validate(name, value).valid, `${name}: ${JSON.stringify(value)}`);
  }
}

test("account creation retains empty generated identities and explicit identity dependency", () => {
  parity("account-create-request", socialCreateAccountRequestSchema, [
    {}, { callsign: "Pilot" }, { callsign: "", display_name: "" }, { display_name: "Pilot" },
    { callsign: null }, { callsign: "pilot", display_name: 3 }, { callsign: "pilot", extra: true }, [], null,
  ]);
  parity("callsign-availability-response", socialCallsignAvailabilitySchema, [
    { available: true, reason: null }, ...["invalid", "reserved", "taken", "blocked"].map((reason) => ({ available: false, reason })),
    { available: true, reason: "taken" }, { available: false, reason: null }, { available: false, reason: "unknown" },
    { available: true, reason: null, extra: true },
  ]);
});

test("account, profile edits and mutuals retain their closed published wire shapes", () => {
  const account = {
    account_id: "11111111-1111-4111-8111-111111111111", kind: "new", callsign: "pilot",
    display_name: null, avatar_url: null, x_handle: null, verified: false,
    onboarding: { shown: false, completed: false }, privacy: "public", sharing_since_ms: null,
    wallets: [],
  };
  parity("me-response", socialMeResponseSchema, [
    { account: null }, { account }, { account: { ...account, display_name: "" } },
    { account: { ...account, account_id: "invalid" } }, { account: { ...account, verified: undefined } },
    { account: { ...account, wallets: [{ address: `0x${"a".repeat(64)}`, kind: "slush", linked_at_ms: 0 }] } },
    { account: { ...account, wallets: [{ address: "0x1", kind: "slush", linked_at_ms: 0 }] } },
  ]);
  parity("profile-edit-request", socialProfileEditRequestSchema, [
    {}, { callsign: "Pilot", display_name: "Name", picture: "none" }, { display_name: "" },
    { display_name: "x".repeat(201) }, { display_name: "😀".repeat(200) }, { picture: "upload" }, { extra: true },
  ]);
  const edit = { display_name: null, picture: "source", avatar_url: null, source_avatar_url: null, upload_available: false };
  parity("profile-edit-response", socialProfileEditSchema, [edit, { ...edit, callsign: "pilot", callsign_editable: true }, { ...edit, avatar_url: "" }, { ...edit, picture: "other" }]);
  const mutual = { callsign: "pilot", display_name: null, avatar_url: null };
  parity("profile-mutuals-response", socialProfileMutualsSchema, [
    { accounts: [], total: 0 }, { accounts: [mutual], total: 1 }, { accounts: Array(4).fill(mutual), total: 4 },
    { accounts: [mutual], total: -1 }, { accounts: [{ ...mutual, extra: true }], total: 1 },
  ]);
});

test("PnL preserves exact signed dollars, canonical origins and nullable synchronization", () => {
  const figures = { realized_usd: "-1.00", unrealized_usd: null, total_usd: "0.00" };
  const asset = { ...figures, presale_id: `0x${"a".repeat(64)}`, coin_type: "coin", symbol: "COIN", icon_url: null, tracked_balance: "0", basis_usd: null };
  const pnl = { scope: "indexed_sale_coins", period: "since_launch", totals: figures, assets: [asset], history_complete: true, wallet_sync: { status: "ready", checkpoint: "001", as_of_ms: null } };
  parity("pnl-response", socialPnlSchema, [
    pnl, { ...pnl, assets: [{ ...asset, presale_id: null, launch_id: `0x${"b".repeat(64)}` }] },
    { ...pnl, assets: [{ ...asset, presale_id: null }] }, { ...pnl, assets: [{ ...asset, presale_id: "0x1" }] },
    { ...pnl, totals: { ...figures, total_usd: 0 } }, { ...pnl, assets: [{ ...asset, total_usd: undefined }] },
    { ...pnl, totals: { ...figures, extra: true } }, { ...pnl, assets: [{ ...asset, extra: true }] },
    { ...pnl, wallet_sync: { ...pnl.wallet_sync, as_of_ms: -1 } },
  ]);
});


test("profile calls keep published amount precision, required why and list bounds", () => {
  const presale = {
    presale_id: `0x${"a".repeat(64)}`, symbol: "COIN", name: "Coin", icon_url: "",
    status: "open", venue: "Cetus", start_ms: 0, end_ms: 10, fill_pct: 1,
    quote_symbol: "USDC", quote_decimals: 6, launched_ms: null, first_unlock_ms: null,
  };
  const call = {
    presale, committed_usd: null, committed_atoms: "1", entry_price_usd: null,
    price_usd: "0.1", multiple: "1.0000", value_usd: "0.00", pnl_usd: "-1.00",
    last_commit_ms: 0, why: null, series: null,
  };
  const page = { calls: [call], track_record: { presales_backed: 1, launched: 0, pnl_usd: null }, as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 } };
  parity("profile-calls-response", socialProfileCallsSchema, [
    page, { ...page, calls: [] }, { ...page, calls: [{ ...call, why: undefined }] },
    { ...page, calls: [{ ...call, why: "😀".repeat(2_000) }] },
    { ...page, calls: [{ ...call, committed_usd: "-1.00" }] },
    { ...page, calls: [{ ...call, multiple: "1.0" }] },
    { ...page, calls: [{ ...call, presale: { ...presale, start_ms: -1 } }] },
    { ...page, calls: Array(201).fill(call) }, { ...page, as_of: { checkpoint: 1 } },
  ]);
});
