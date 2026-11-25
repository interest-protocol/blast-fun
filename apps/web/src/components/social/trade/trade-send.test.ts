import { diagnosticMessage } from "#web/lib/errors.ts";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToastOptions } from "#web/components/blast-ui/Toasts.tsx";
import { fastTimeouts } from "../../../../test/fixtures/social/fast-timeouts.ts";
beforeEach(() => fastTimeouts());
afterEach(() => mock.restoreAll());

import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import { SOCIAL_TRADES_PATH, socialTradeSettlePath, type SocialTrade, type SocialTradeQuote } from "@blast/core/modules/social/contracts/trades.ts";

import { fixtureCoinType, fixtureTradeQuote, fixtureWallet, FIXTURE_USDC } from "../../../../test/fixtures/social/trade/trade-fixtures.ts";
import type { CommitSigner } from "../commit/commit-flow";
import { sendTrade, WALLET_NOT_READY, type TradeSendDependencies } from "./trade-send";

/**
 * R3-55 over R3-31: the trade kit's `send`, through the real `runTrade` and
 * the routes' answers on a recording transport. AC-6: what is submitted is
 * the quote's own token amount and minimum, and the fill is held to it.
 * AC-11: an embedded Blast wallet is sponsored (`Paid by Blast`) and executes
 * through the sponsor; a wallet session pays its own and executes on the
 * fullnode. The Feel layer's buy, sell and error cues, the toast and the balances.
 */

const KSTL = fixtureCoinType("KSTL");
const ADDRESS = normalizeSuiAddress(fixtureWallet().address!);
const SPONSOR = normalizeSuiAddress("0x5b");
const NOW = Date.now();

function bytesFor(sender: string, owner: string): Uint8Array {
  return bcs.TransactionData.serialize({
    V1: {
      kind: { ProgrammableTransaction: { inputs: [], commands: [] } },
      sender,
      gasData: { payment: [], owner, price: 750n, budget: 2_000_000n },
      expiration: { None: true },
    },
  }).toBytes();
}

const sellQuote = (): SocialTradeQuote =>
  fixtureTradeQuote({ in_coin: KSTL, out_coin: FIXTURE_USDC, side: "sell", amount_in: "47619047619047" }, { signedIn: true, nowMs: NOW, wallet: fixtureWallet() });
const buyQuote = (fee: "blast" | "wallet"): SocialTradeQuote =>
  fixtureTradeQuote({ in_coin: FIXTURE_USDC, out_coin: KSTL, side: "buy", amount_in: "100000000" }, { signedIn: true, fee, nowMs: NOW, wallet: fixtureWallet() });

function built(quote: SocialTradeQuote, payer: "blast" | "wallet", bytes: Uint8Array): SocialTrade {
  return {
    trade_id: "00000000-0000-4000-8000-000000000055",
    status: "built",
    side: quote.side,
    in_coin: quote.in_coin,
    out_coin: quote.out_coin,
    amount_in: quote.amount_in!,
    amount_out: quote.amount_out!,
    min_out: quote.min_out!,
    amount_out_filled: null,
    route_label: quote.route_label,
    network_fee: { payer, label: payer === "blast" ? "Paid by Blast" : "Paid from your SUI" },
    reservation_id: payer === "blast" ? "00000000-0000-4000-8000-0000000000aa" : null,
    transaction_bytes: toBase64(bytes),
    digest: TransactionDataBuilder.getDigestFromBytes(bytes),
    expires_at_ms: NOW + 60_000,
    failure_code: null,
    created_at_ms: NOW,
    settled_at_ms: null,
  };
}

type Call = Readonly<{ url: string; body: unknown }>;

function setup(options: Readonly<{ fee: "sponsored" | "wallet"; session?: boolean; create: (body: Record<string, unknown>) => { status: number; body: unknown }; settled?: SocialTrade }>) {
  const calls: Call[] = [];
  const executed: Uint8Array[] = [];
  const played: string[] = [];
  const signed: Uint8Array[] = [];
  const toasts: { title: string; options: ToastOptions | undefined }[] = [];
  let moved = 0;
  let trade: SocialTrade | null = null;
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: path, body });
    if (path === SOCIAL_TRADES_PATH) {
      const answer = options.create(body);
      if (answer.status < 300) trade = answer.body as SocialTrade;
      return Response.json(answer.body, { status: answer.status });
    }
    if (path.endsWith("/execute")) return Response.json({ digest: trade?.digest, effects: { status: "success" } });
    if (trade !== null && path === socialTradeSettlePath(trade.trade_id)) return Response.json(options.settled ?? { ...trade, status: "confirmed", amount_out_filled: trade.amount_out, transaction_bytes: null });
    throw new Error(`unexpected ${path}`);
  }) as typeof globalThis.fetch;
  const sponsored: CommitSigner = { fee: "sponsored", address: ADDRESS, signTransaction: async (bytes) => { signed.push(bytes); return "c2lnbmF0dXJl"; } };
  const deps: TradeSendDependencies = {
    api: { getAccessToken: async () => "privy-token", fetch },
    client: () =>
      ({
        core: {
          async executeTransaction({ transaction }: { transaction: Uint8Array }) {
            executed.push(transaction);
            return { $kind: "Transaction" };
          },
        },
      }) as unknown as ClientWithCoreApi,
    wallet: async () => (options.session ? { ...fixtureWallet(options.fee), signer: "wallet" as const } : fixtureWallet(options.fee)),
    suiBalance: async () => BigInt(fixtureWallet().coins!.find((coin) => coin.symbol === "SUI")!.atoms),
    embedded: () => sponsored,
    walletSigner: (address) => ({ fee: "wallet", address, signTransaction: async (bytes) => { signed.push(bytes); return { bytes: toBase64(bytes), signature: "c2lnbmF0dXJl" }; } }),
    flow: () => import("../trades/trade-flow"),
    key: () => "4a0b7c5e-8f3d-4b2a-9c1e-6d5f4e3a2b1c",
    play: (cue) => void played.push(cue.kind),
    toast: (title, toastOptions) => void toasts.push({ title, options: toastOptions }),
    explorer: "suiscan",
    moved: () => void (moved += 1),
  };
  return { deps, calls, executed, signed, played, toasts, moved: () => moved };
}

const COINS_SELL = { in: { symbol: "KSTL", decimals: 9 }, out: { symbol: "USDC", decimals: 6 } };
const COINS_BUY = { in: { symbol: "USDC", decimals: 6 }, out: { symbol: "KSTL", decimals: 9 } };

test("R3-55-AC-6: a sell submits the quote's token amount and minimum, and fills at or above it", async () => {
  const quote = sellQuote();
  const bytes = bytesFor(ADDRESS, SPONSOR);
  const h = setup({ fee: "sponsored", create: () => ({ status: 201, body: built(quote, "blast", bytes) }) });
  const result = await sendTrade(h.deps, { quote, coins: COINS_SELL });
  const create = h.calls.find((call) => call.url === SOCIAL_TRADES_PATH);
  assert.deepEqual(create?.body, {
    quote_id: quote.quote_id,
    amount_in: "47619047619047",
    min_out: quote.min_out,
    idempotency_key: "4a0b7c5e-8f3d-4b2a-9c1e-6d5f4e3a2b1c",
  }, "the tokens, not the $100 typed; the quote's own minimum");
  assert.equal(result.status, "traded");
  const settled = h.calls.filter((call) => call.url.endsWith("/settle")).length;
  assert.ok(settled >= 1, "the fill is read from the chain (settle)");
  assert.ok(BigInt(quote.amount_out!) >= BigInt(quote.min_out!), "the swap cannot fill below min_out (in the transaction)");
  assert.deepEqual(h.toasts.map((toast) => toast.title), ["Traded 47,619 KSTL for 99.89 USDC"]);
  const { titleContent, ...options } = h.toasts[0]!.options!;
  assert.match(renderToStaticMarkup(titleContent), /99\.89.*data-coin-mark=.*\/coins\/usdc\.svg/);
  assert.deepEqual(options, {
    sub: "KSTL → USDC · Cetus",
    href: `https://suiscan.xyz/mainnet/tx/${built(quote, "blast", bytes).digest}`,
    link: "View on Suiscan",
  });
  assert.deepEqual(h.played, ["sell"]);
  assert.equal(h.moved(), 1, "the balances read again");
});

test("R3-55-AC-11: an embedded wallet's trade is sponsored and executes through the sponsor", async () => {
  const quote = buyQuote("blast");
  assert.equal(quote.network_fee?.label, "Paid by Blast");
  const h = setup({ fee: "sponsored", create: () => ({ status: 201, body: built(quote, "blast", bytesFor(ADDRESS, SPONSOR)) }) });
  await sendTrade(h.deps, { quote, coins: COINS_BUY });
  assert.ok(h.calls.some((call) => call.url.startsWith("/api/presale/sponsor/") && call.url.endsWith("/execute")));
  assert.deepEqual(h.executed, [], "the fullnode is not asked");
});

test("a trade cannot execute with a different wallet than the balance check", async () => {
  const h = setup({ fee: "sponsored", create: () => { throw new Error("trade must stay unsigned"); } });
  const result = await sendTrade(h.deps, { quote: buyQuote("blast"), coins: COINS_BUY, walletAddress: SPONSOR });
  assert.equal(result.status, "refused");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.signed, []);
});

test("a wallet session's trade is sponsored like an embedded wallet's: its wallet signs the sponsor's bytes, the sponsor executes", async () => {
  const quote = buyQuote("blast");
  const bytes = bytesFor(ADDRESS, SPONSOR);
  const h = setup({ fee: "sponsored", session: true, create: () => ({ status: 201, body: built(quote, "blast", bytes) }) });
  const result = await sendTrade({ ...h.deps, embedded: () => null }, { quote, coins: COINS_BUY });
  assert.equal(result.status, "traded");
  assert.deepEqual(h.signed.map((signed) => [...signed]), [[...bytes]], "the wallet signed exactly the sponsor's bytes");
  assert.ok(h.calls.some((call) => call.url.startsWith("/api/presale/sponsor/") && call.url.endsWith("/execute")));
  assert.deepEqual(h.executed, [], "the fullnode is not asked");
});

test("R3-55-AC-11: a wallet session the server answers wallet-pays pays its own fee and executes on the fullnode", async () => {
  const quote = buyQuote("wallet");
  assert.equal(quote.network_fee?.label, "Paid from your SUI");
  const bytes = bytesFor(ADDRESS, ADDRESS);
  const h = setup({ fee: "wallet", create: () => ({ status: 201, body: built(quote, "wallet", bytes) }) });
  const result = await sendTrade(h.deps, { quote, coins: COINS_BUY });
  assert.equal(result.status, "traded");
  assert.equal(h.calls.some((call) => call.url.includes("/api/presale/sponsor")), false, "the sponsor is never called");
  assert.equal(h.executed.length, 1);
  assert.deepEqual([...h.executed[0]!], [...bytes]);
});

test("Blast not paying today: no sound, no toast, nothing recorded; the next send pays from the wallet", async () => {
  const quote = buyQuote("blast");
  const bytes = bytesFor(ADDRESS, ADDRESS);
  const h = setup({
    fee: "sponsored",
    create: (body) =>
      body.accept_fee === true ? { status: 201, body: built(quote, "wallet", bytes) } : { status: 409, body: { error: { code: "sponsorship_unavailable", message: "x", fee_mist: "3120000" } } },
  });
  assert.deepEqual(await sendTrade(h.deps, { quote, coins: COINS_BUY }), { status: "fee_required", feeMist: "3120000" });
  assert.deepEqual([h.played, h.toasts, h.moved()], [[], [], 0]);
  const paid = await sendTrade(h.deps, { quote, coins: COINS_BUY, acceptFee: true });
  assert.equal(paid.status, "traded");
  assert.equal((h.calls.filter((call) => call.url === SOCIAL_TRADES_PATH).at(-1)?.body as Record<string, unknown>).accept_fee, true);
});

test("the coins sheet's own key (one per quote, R3-33) is the trade's idempotency key; a fee prompt's second send keeps it", async () => {
  const quote = buyQuote("blast");
  const bytes = bytesFor(ADDRESS, ADDRESS);
  const h = setup({
    fee: "sponsored",
    create: (body) =>
      body.accept_fee === true ? { status: 201, body: built(quote, "wallet", bytes) } : { status: 409, body: { error: { code: "sponsorship_unavailable", message: "x", fee_mist: "3120000" } } },
  });
  const key = "9d6c1b2a-3e4f-4a5b-8c7d-0e1f2a3b4c5d";
  await sendTrade(h.deps, { quote, coins: COINS_BUY, idempotencyKey: key });
  await sendTrade(h.deps, { quote, coins: COINS_BUY, acceptFee: true, idempotencyKey: key });
  const keys = h.calls.filter((call) => call.url === SOCIAL_TRADES_PATH).map((call) => (call.body as Record<string, unknown>).idempotency_key);
  assert.deepEqual(keys, [key, key]);
});

test("a refused trade plays the error cue and says the route's code (R3-27 logs it server-side)", async () => {
  const quote = buyQuote("blast");
  const h = setup({ fee: "sponsored", create: () => ({ status: 201, body: { ...built(quote, "blast", bytesFor(ADDRESS, SPONSOR)), status: "failed", failure_code: "price_moved", transaction_bytes: null } }) });
  const result = await sendTrade(h.deps, { quote, coins: COINS_BUY });
  assert.deepEqual(result, { status: "refused", code: "price_moved", message: "That didn’t go through Code: price_moved." });
  assert.deepEqual(h.played, ["error"]);
  assert.deepEqual(h.toasts, []);
});

test("cancelling the wallet prompt gives text feedback without an error sound", async () => {
  const quote = buyQuote("blast");
  const h = setup({ fee: "sponsored", create: () => ({ status: 201, body: built(quote, "blast", bytesFor(ADDRESS, SPONSOR)) }) });
  const result = await sendTrade({
    ...h.deps,
    embedded: () => ({
      fee: "sponsored",
      address: ADDRESS,
      signTransaction: async () => { throw new Error("User rejected the request"); },
    }),
  }, { quote, coins: COINS_BUY });
  assert.equal(result.status, "refused");
  if (result.status === "refused") assert.equal(result.code, "rejected");
  assert.deepEqual(h.played, []);
});

test("no signer for the wallet (no embedded key, an address that is not the wallet's): nothing is sent", async () => {
  const h = setup({ fee: "sponsored", create: () => ({ status: 201, body: {} }) });
  const result = await sendTrade({ ...h.deps, embedded: () => null }, { quote: buyQuote("blast"), coins: COINS_BUY });
  assert.deepEqual(result, { status: "refused", code: "signer-unavailable", message: diagnosticMessage(WALLET_NOT_READY, { code: "signer-unavailable" }) });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.played, ["error"]);
  const expired = await sendTrade(h.deps, { quote: { ...buyQuote("blast"), quote_id: null }, coins: COINS_BUY });
  assert.equal(expired.status, "refused", "a quote that was never offered is not sent");
});

test("sent, and the chain does not show it yet: `Trade sent`, no fill claimed and no success cue, the balances read again", async () => {
  const quote = buyQuote("blast");
  const bytes = bytesFor(ADDRESS, SPONSOR);
  const pending = built(quote, "blast", bytes);
  const h = setup({ fee: "sponsored", create: () => ({ status: 201, body: pending }), settled: { ...pending, transaction_bytes: null } });
  const result = await sendTrade(h.deps, { quote, coins: COINS_BUY });
  assert.deepEqual(result, { status: "pending", title: "Trade sent" });
  assert.equal(h.toasts[0]!.title, "Trade sent");
  assert.equal((h.toasts[0]!.options as { sub?: string }).sub, "Your coins update when it lands");
  assert.deepEqual(h.played, [], "no success cue for a fill nobody has seen");
  assert.equal(h.moved(), 1);
});

test("sponsorship refusal with zero native SUI cannot offer a payable fallback", async () => {
  const quote = buyQuote("blast");
  const h = setup({ fee: "sponsored", create: () => ({ status: 409, body: { error: { code: "sponsorship_unavailable", fee_mist: "2350349" } } }) });
  const wallet = fixtureWallet();
  const result = await sendTrade({ ...h.deps, wallet: async () => ({ address: wallet.address, signer: wallet.signer }), suiBalance: async () => 0n }, { quote, coins: { ...COINS_BUY, in: { symbol: "TSUI", decimals: 9 } } });
  assert.equal(result.status, "fee_required");
  assert.equal((result as { payable?: boolean }).payable, false);
  assert.match((result as { message?: string }).message ?? "", /native SUI/);
  assert.doesNotMatch((result as { message?: string }).message ?? "", /Not enough TSUI/);
  assert.deepEqual(h.executed, []);
  assert.deepEqual(h.toasts, []);
});

const TSUI_TYPE = "0x963331df9a26c8674c33eb97655fe44807d5ff1aa4092bcbe2bdbe044b17b03d::test_sui::TEST_SUI";
const LICK_TYPE = "0x402e70021c3982e02e9c2d2eeeee646812ae6a70ca5087f4e662ed8d0333cf68::lick::LICK";
const CAPTURED_COINS = { in: { symbol: "TSUI", decimals: 9 }, out: { symbol: "LICK", decimals: 6 } };
const capturedQuote = () => ({ ...buyQuote("blast"), in_coin: TSUI_TYPE, out_coin: LICK_TYPE, amount_in: "100000000000000", amount_out: "546438621442918", min_out: "543706428335703", route_label: "TSUI → LICK · Bluefin", network_fee: { payer: "blast" as const, label: "Paid by Blast" as const, estimate_mist: "2350349" } });

for (const detailed of [false, true]) {
  test(`captured 409 → 201 failed → 200 failed replay, structured details ${detailed}`, async () => {
    const quote = capturedQuote();
    const failed = { ...built(quote, "wallet", bytesFor(ADDRESS, ADDRESS)), trade_id: "fef3c51c-9b6c-461b-a709-44b474080651", status: "failed", failure_code: "insufficient_balance", network_fee: null, reservation_id: null, transaction_bytes: null, digest: null, expires_at_ms: null,
      ...(detailed ? { balance_failure: { reason: "gas", coin_type: fixtureWallet().coins![1]!.coin_type, required_atoms: "2820419", available_atoms: "0" } } : {}),
    };
    let accepted = 0;
    const h = setup({ fee: "sponsored", create: (body) => body.accept_fee ? { status: ++accepted === 1 ? 201 : 200, body: failed } : { status: 409, body: { error: { code: "sponsorship_unavailable", fee_mist: "2350349" } } } });
    const deps = { ...h.deps, suiBalance: async () => 0n };
    const input = { quote, coins: CAPTURED_COINS, idempotencyKey: "4a0b7c5e-8f3d-4b2a-9c1e-6d5f4e3a2b1c" };
    const prompt = await sendTrade(deps, input);
    assert.equal(prompt.status, "fee_required");
    if (prompt.status === "fee_required") assert.equal(prompt.payable, false);
    for (let i = 0; i < 2; i += 1) {
      const result = await sendTrade(deps, { ...input, acceptFee: true });
      assert.equal(result.status, "refused");
      if (result.status === "refused") {
        assert.match(result.message, /native SUI/);
        assert.doesNotMatch(result.message, /Not enough TSUI/);
        if (detailed) assert.match(result.message, /0.002820419 SUI/);
      }
    }
    assert.deepEqual([h.signed, h.executed, h.toasts], [[], [], []]);
    assert.ok(h.played.every((cue) => cue === "error"));
    assert.equal(new Set(h.calls.map((call) => (call.body as Record<string, unknown>).idempotency_key)).size, 1);
    assert.equal(h.calls.every((call) => call.url === SOCIAL_TRADES_PATH), true);
  });
}

test("genuine TSUI shortage names TSUI and its required amount", async () => {
  const quote = capturedQuote();
  const h = setup({ fee: "sponsored", create: () => ({ status: 201, body: { ...built(quote, "blast", bytesFor(ADDRESS, SPONSOR)), status: "failed", failure_code: "insufficient_balance", transaction_bytes: null, balance_failure: { reason: "input", coin_type: TSUI_TYPE, required_atoms: quote.amount_in, available_atoms: "0" } } }) });
  const result = await sendTrade(h.deps, { quote, coins: CAPTURED_COINS });
  assert.equal(result.status, "refused");
  if (result.status === "refused") assert.match(result.message, /Not enough TSUI.*100,000 TSUI/);
  assert.deepEqual(h.signed, []);
});

test("sponsorship succeeds with zero native SUI", async () => {
  const quote = capturedQuote();
  const h = setup({ fee: "sponsored", create: () => ({ status: 201, body: built(quote, "blast", bytesFor(ADDRESS, SPONSOR)) }) });
  const result = await sendTrade({ ...h.deps, suiBalance: async () => assert.fail("a sponsored trade should not need a gas balance read") }, { quote, coins: CAPTURED_COINS });
  assert.equal(result.status, "traded");
  assert.equal(h.signed.length, 1);
  assert.deepEqual(h.played, ["buy"]);
});


test("an unreadable native SUI balance cannot claim zero funds or offer fee acceptance", async () => {
  const quote = capturedQuote();
  const h = setup({ fee: "sponsored", create: () => ({ status: 409, body: { error: { code: "sponsorship_unavailable", fee_mist: "2350349" } } }) });
  const result = await sendTrade({ ...h.deps, suiBalance: async () => null }, { quote, coins: CAPTURED_COINS });
  assert.equal(result.status, "refused");
  if (result.status === "refused") {
    assert.match(result.message, /balance could not be checked/);
    assert.doesNotMatch(result.message, /Not enough/);
  }
  assert.deepEqual([h.signed, h.executed, h.toasts], [[], [], []]);
});
test("a native SUI input must leave the full gas budget available", async () => {
  const quote = { ...capturedQuote(), in_coin: fixtureWallet().coins![1]!.coin_type };
  const h = setup({ fee: "sponsored", create: () => ({ status: 409, body: { error: { code: "sponsorship_unavailable", fee_mist: "2350349", required_mist: "2820419" } } }) });
  const held = BigInt(quote.amount_in!) + 2820419n - 1n;
  const result = await sendTrade({ ...h.deps, suiBalance: async () => held }, { quote, coins: { ...CAPTURED_COINS, in: { symbol: "SUI", decimals: 9 } } });
  assert.equal(result.status, "fee_required");
  if (result.status === "fee_required") {
    assert.equal(result.payable, false);
    assert.match(result.message!, /100,000\.002820419 SUI/);
  }
  assert.deepEqual(h.signed, []);
});

test("a confirmed trade remains successful when display or balance refresh feedback fails", async () => {
  const quote = buyQuote("blast");
  const h = setup({ fee: "sponsored", create: () => ({ status: 201, body: built(quote, "blast", bytesFor(ADDRESS, SPONSOR)) }) });
  const result = await sendTrade({ ...h.deps, moved() { throw new Error("workspace read unavailable"); }, play() { throw new Error("display detached"); }, toast() { throw new Error("notice unavailable"); } }, { quote, coins: COINS_BUY });
  assert.equal(result.status, "traded");
});
