import assert from "node:assert/strict";
import test from "node:test";

import { SOCIAL_TRADE_QUOTE_PATH, type SocialTradeQuote } from "@blast/core/modules/social/contracts/trades.ts";

import { impactText, impactTone, isOffered, requoteInMs, unavailableText } from "./trade-quote-view";
import { createTrade, isSocialTradeQuote, requestTradeQuote } from "./trades-client";

/**
 * Social feed R3-30: the trade surfaces' quote call goes through the shared
 * session helper (OA-16: the Privy token when there is one, else only the
 * same-origin wallet cookie; never a hand-built header), and the words every
 * surface shares follow the gate (§15.7.5).
 */

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const COIN = "0x0000000000000000000000000000000000000000000000000000000000000b0b::bee::BEE";

const QUOTE: SocialTradeQuote = {
  quote_id: "q1.abcdefghijklmnopqrstuvwxyz",
  expires_at_ms: 1_000_020_000,
  quoted_at_ms: 1_000_000_000,
  side: "buy",
  in_coin: SUI,
  out_coin: COIN,
  amount_in: "100000000",
  amount_out: "332001975262684891",
  min_out: "330341965386371466",
  slippage_bps: 50,
  price_impact_bps: 11,
  price_impact_unavailable: null,
  fee_bps: 100,
  fee_amount: "1000000",
  blast_fee_bps: 50,
  blast_fee_amount: "1668351634485853",
  route: [{ pool_id: `0x${"b".repeat(64)}`, venue: "cetus", in_coin: SUI, out_coin: COIN, amount_in: "100000000", amount_out: "332001975262684891" }],
  route_label: "SUI → BEE · Cetus",
  price_per_out: "0.00000000006",
  amount_in_usd: "0.12",
  amount_out_usd: "0.02",
  network_fee: { payer: "blast", label: "Paid by Blast", estimate_mist: "1500000" },
  dry_run: "passed",
  offer_refused: null,
  unavailable_reason: null,
};

type Seen = { url: string; init: RequestInit };

function transport(status: number, body: unknown, seen: Seen[], headers: HeadersInit = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { ...Object.fromEntries(new Headers(headers)), "content-type": "application/json" } });
  }) as typeof fetch;
}

test("a quote request posts the body to the quote route with the viewer's session, never caching", async () => {
  const seen: Seen[] = [];
  const body = { in_coin: SUI, out_coin: COIN, side: "buy" as const, amount_in: "100000000" };
  const result = await requestTradeQuote({ getAccessToken: async () => "privy-token", fetch: transport(200, QUOTE, seen) }, body);
  assert.deepEqual(result, { status: "ok", body: QUOTE, httpStatus: 200 });
  assert.equal(seen[0]!.url, SOCIAL_TRADE_QUOTE_PATH);
  assert.equal(seen[0]!.init.method, "POST");
  assert.equal(seen[0]!.init.cache, "no-store");
  assert.equal(seen[0]!.init.credentials, "same-origin");
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, "Bearer privy-token");
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), body);
});

test("a signed-out visitor's quote request carries no authorization header", async () => {
  const seen: Seen[] = [];
  const signedOut = { ...QUOTE, quote_id: null, expires_at_ms: null, network_fee: null, dry_run: "not_run" as const, offer_refused: "sign_in" as const };
  const result = await requestTradeQuote({ getAccessToken: async () => null, fetch: transport(200, signedOut, seen) }, { in_coin: SUI, out_coin: COIN, side: "buy", amount_in: "1" });
  assert.equal(result.status, "ok");
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, undefined);
});

test("a refusal is its published code; a malformed answer is an error, not a quote", async () => {
  const seen: Seen[] = [];
  assert.deepEqual(
    await requestTradeQuote({ getAccessToken: async () => null, fetch: transport(429, { error: { code: "rate_limited", message: "private-provider-detail" } }, seen, { "X-Request-ID": "quote-ref-1", "Retry-After": "12" }) }, { in_coin: SUI, out_coin: COIN, side: "buy", amount_in: "1" }),
    { status: "refused", code: "rate_limited", retryAfterSeconds: 12, httpStatus: 429, requestId: "quote-ref-1" },
  );
  assert.deepEqual(
    await requestTradeQuote({ getAccessToken: async () => null, fetch: transport(200, { ...QUOTE, amount_out: 1.5 }, seen, { "X-Request-ID": "invalid-quote-ref-1" }) }, { in_coin: SUI, out_coin: COIN, side: "buy", amount_in: "1" }),
    { status: "error", code: "invalid_response", httpStatus: 200, requestId: "invalid-quote-ref-1" },
  );
  for (const broken of [{ ...QUOTE, amount_out: 1.5 }, { ...QUOTE, offer_refused: "maybe" }, { ...QUOTE, route: [{}] }, { ...QUOTE, network_fee: { payer: "blast" } }, { ...QUOTE, price_impact_unavailable: "guessed" }, { ...QUOTE, blast_fee_bps: 0.5 }, { ...QUOTE, blast_fee_bps: 1_001 }, { ...QUOTE, blast_fee_bps: undefined }, { ...QUOTE, blast_fee_amount: 1000 }]) {
    assert.equal(isSocialTradeQuote(broken), false);
  }
  assert.equal(isSocialTradeQuote(QUOTE), true);
  assert.equal(isSocialTradeQuote({ ...QUOTE, price_impact_bps: null, price_impact_unavailable: "too_small" }), true, "OA-29: no impact, and why");
});

test("impact reads as the gate writes it: <0.01% under a basis point, trailing zeros trimmed", () => {
  assert.equal(impactText(0), "<0.01%");
  assert.equal(impactText(11), "0.11%");
  assert.equal(impactText(10), "0.1%");
  assert.equal(impactText(300), "3%");
  assert.equal(impactText(1_234), "12.34%");
  assert.equal(impactTone(300), "plain");
  assert.equal(impactTone(301), "warn");
  assert.equal(impactTone(1_000), "warn");
  assert.equal(impactTone(1_001), "down");
});

test("a quote is offered until it expires, and asked again two seconds before", () => {
  assert.equal(isOffered(QUOTE, 1_000_019_999), true);
  assert.equal(isOffered(QUOTE, 1_000_020_000), false);
  assert.equal(isOffered({ ...QUOTE, quote_id: null, expires_at_ms: null }, 0), false);
  assert.equal(requoteInMs(QUOTE, 1_000_000_000), 18_000);
  assert.equal(requoteInMs(QUOTE, 1_000_019_500), 1_000);
  assert.equal(requoteInMs({ ...QUOTE, expires_at_ms: null }, 0), null);
  assert.equal(unavailableText("no_pool"), "No market for this trade yet");
});


test("balance diagnostics and fee budgets validate exact atom strings at the API boundary", async () => {
  const balance = { reason: "gas", coin_type: SUI, required_atoms: "2820419", available_atoms: "0" };
  assert.equal(isSocialTradeQuote({ ...QUOTE, balance_failure: balance }), true);
  for (const invalid of [{ ...balance, reason: "unknown" }, { ...balance, required_atoms: "1.5" }, { ...balance, available_atoms: "-1" }, { ...balance, coin_type: "" }]) {
    assert.equal(isSocialTradeQuote({ ...QUOTE, balance_failure: invalid }), false);
  }
  const request = { quote_id: "quote", amount_in: "1", min_out: "1", idempotency_key: "4a0b7c5e-8f3d-4b2a-9c1e-6d5f4e3a2b1c" };
  const error = { code: "sponsorship_unavailable", fee_mist: "2350349", required_mist: "2820419" };
  const options = (body: unknown) => ({ getAccessToken: async () => "token", fetch: transport(409, body, []) });
  assert.deepEqual(await createTrade(options({ error }), request), { status: "fee_required", feeMist: "2350349", requiredMist: "2820419" });
  assert.equal((await createTrade(options({ error: { ...error, required_mist: "2.82" } }), request)).status, "error");
  assert.equal((await createTrade(options({ error: { ...error, fee_mist: "0.002350349" } }), request)).status, "error");
});
