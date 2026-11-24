import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { fastTimeouts } from "../../../../test/fixtures/social/fast-timeouts.ts";
beforeEach(() => fastTimeouts());
afterEach(() => mock.restoreAll());

import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import { PublicError } from "#web/lib/errors.ts";

import { SOCIAL_TRADES_PATH, socialTradeSettlePath, type SocialTrade } from "@blast/core/modules/social/contracts/trades.ts";

import type { TransactionSigner } from "#web/components/social/sponsored-transaction.ts";

import { readBuiltBytes, runTrade, TRADE_BYTES_CHANGED, TRADE_BYTES_UNEXPECTED, TRADE_FAILED, TRADE_NOT_SIGNED } from "./trade-flow";

/**
 * Social feed R3-31: the browser's half of a trade. The server builds; the
 * wallet signs exactly those bytes and nothing else (AC-7's signer boundary:
 * nothing executes unsigned, nothing signed is replaced, and the browser never
 * holds a key other than the wallet's); a sponsored trade executes through the
 * sponsor, one the wallet pays through the fullnode; the outcome comes from
 * the settle route, which reads the chain.
 */

const WALLET = normalizeSuiAddress("0xe3b");
const COIN = "0x0000000000000000000000000000000000000000000000000000000000000b0b::bee::BEE";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

function bytesFor(sender: string, owner = SPONSOR): Uint8Array {
  return bcs.TransactionData.serialize({
    V1: {
      kind: { ProgrammableTransaction: { inputs: [], commands: [] } },
      sender,
      gasData: { payment: [], owner, price: 750n, budget: 2_000_000n },
      expiration: { None: true },
    },
  }).toBytes();
}
const SPONSOR = normalizeSuiAddress("0x5b");
const BYTES = bytesFor(WALLET);
const DIGEST = TransactionDataBuilder.getDigestFromBytes(BYTES);

function trade(overrides: Partial<SocialTrade> = {}): SocialTrade {
  return {
    trade_id: "00000000-0000-4000-8000-000000000001",
    status: "built",
    side: "buy",
    in_coin: SUI,
    out_coin: COIN,
    amount_in: "100000000",
    amount_out: "332001975262684891",
    min_out: "330341965386371466",
    amount_out_filled: null,
    route_label: "SUI → BEE · Cetus",
    network_fee: { payer: "blast", label: "Paid by Blast" },
    reservation_id: "00000000-0000-4000-8000-0000000000aa",
    transaction_bytes: toBase64(BYTES),
    digest: DIGEST,
    expires_at_ms: 1,
    failure_code: null,
    created_at_ms: 1,
    settled_at_ms: null,
    ...overrides,
  };
}

type Call = { url: string; body: unknown };

/** A transport: the trade answer, the sponsor's execute, then the settle answers in order. */
function api(create: { status: number; body: unknown }, settles: SocialTrade[] = [], calls: Call[] = []) {
  let settle = 0;
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    calls.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === SOCIAL_TRADES_PATH) return Response.json(create.body, { status: create.status });
    if (path.endsWith("/execute")) return Response.json({ digest: DIGEST, effects: { status: "success", gas_used: "1500000" } });
    if (path === socialTradeSettlePath(trade().trade_id)) return Response.json(settles[Math.min(settle++, settles.length - 1)] ?? trade());
    throw new Error(`unexpected ${path}`);
  }) as typeof globalThis.fetch;
  return { getAccessToken: async () => "privy-token", fetch };
}

/** Privy's embedded key; with `returnBytes`, a wallet (Slush) that answers those bytes as the ones it signed. */
function signer(options: { refuse?: boolean; returnBytes?: string } = {}): TransactionSigner & { signed: Uint8Array[] } {
  const signed: Uint8Array[] = [];
  const sign = async (bytes: Uint8Array) => {
    if (options.refuse) throw new Error("User rejected the request");
    signed.push(bytes);
    return "c2lnbmF0dXJl";
  };
  const { returnBytes } = options;
  return returnBytes === undefined
    ? { fee: "sponsored", address: WALLET, signed, signTransaction: sign }
    : { fee: "wallet", address: WALLET, signed, signTransaction: async (bytes) => ({ signature: await sign(bytes), bytes: returnBytes }) };
}

function fullnode(executed: Uint8Array[] = []) {
  return {
    core: {
      async executeTransaction({ transaction }: { transaction: Uint8Array }) {
        executed.push(transaction);
        return { $kind: "Transaction" };
      },
    },
  } as unknown as ClientWithCoreApi;
}

const request = { quoteId: "q1.xyz", amountIn: "100000000", minOut: "330341965386371466", idempotencyKey: "4a0b7c5e-8f3d-4b2a-9c1e-6d5f4e3a2b1c", inSymbol: "SUI" };

test("a sponsored trade: the server's bytes signed as they are, executed through the sponsor, then settled from the chain", async () => {
  const calls: Call[] = [];
  const wallet = signer();
  const executed: Uint8Array[] = [];
  const confirmed = trade({ status: "confirmed", amount_out_filled: "332001975262684800", transaction_bytes: null });
  const phases: string[] = [];
  const result = await runTrade(
    { api: api({ status: 201, body: trade() }, [trade(), confirmed], calls), client: fullnode(executed), signer: wallet, onPhase: (phase) => phases.push(phase) },
    request,
  );
  assert.deepEqual(result, { status: "traded", trade: confirmed });
  assert.deepEqual(wallet.signed, [BYTES], "exactly the built bytes");
  assert.deepEqual(executed, [], "the sponsor executes it, not the fullnode");
  assert.deepEqual(calls.map((call) => call.url), [SOCIAL_TRADES_PATH, `/api/presale/sponsor/${trade().reservation_id}/execute`, socialTradeSettlePath(trade().trade_id), socialTradeSettlePath(trade().trade_id)]);
  assert.deepEqual(calls[0]!.body, { quote_id: "q1.xyz", amount_in: "100000000", min_out: "330341965386371466", idempotency_key: request.idempotencyKey });
  assert.deepEqual(phases, ["preparing", "signing", "trading", "settling"]);
});

test("a trade the wallet pays for executes on the fullnode", async () => {
  const executed: Uint8Array[] = [];
  const own = trade({ network_fee: { payer: "wallet", label: "Paid from your SUI" }, reservation_id: null });
  const result = await runTrade(
    { api: api({ status: 201, body: own }, [{ ...own, status: "confirmed", amount_out_filled: own.amount_out, transaction_bytes: null }]), client: fullnode(executed), signer: signer() },
    { ...request, acceptFee: true },
  );
  assert.equal(result.status, "traded");
  assert.deepEqual(executed, [BYTES]);

  const slush = signer({ returnBytes: toBase64(BYTES) });
  const walletSession = await runTrade(
    { api: api({ status: 201, body: own }, [{ ...own, status: "confirmed", amount_out_filled: own.amount_out, transaction_bytes: null }]), client: fullnode(executed), signer: slush },
    request,
  );
  assert.equal(walletSession.status, "traded", "a wallet that answers the bytes it was given sends them");
  assert.deepEqual(executed, [BYTES, BYTES]);
});

test("nothing is executed unsigned, nothing signed that the server did not build, nothing sent that the wallet rebuilt (R3-31-AC-7)", async () => {
  const executed: Uint8Array[] = [];
  const refused = await runTrade({ api: api({ status: 201, body: trade() }), client: fullnode(executed), signer: signer({ refuse: true }) }, request);
  assert.deepEqual(refused, { status: "failed", message: `${TRADE_NOT_SIGNED} Code: rejected.`, code: "rejected", trade: trade() });

  const other = bytesFor(normalizeSuiAddress("0xbad"));
  const foreign = trade({ transaction_bytes: toBase64(other), digest: TransactionDataBuilder.getDigestFromBytes(other) });
  const wallet = signer();
  const unexpected = await runTrade({ api: api({ status: 201, body: foreign }), client: fullnode(executed), signer: wallet }, request);
  assert.deepEqual(unexpected, { status: "failed", message: `${TRADE_BYTES_UNEXPECTED} Code: invalid_response.`, code: null, trade: foreign });
  assert.deepEqual(wallet.signed, [], "bytes for another sender are never signed");
  assert.equal(readBuiltBytes(toBase64(BYTES), trade({ digest: "x" }), WALLET), null, "nor bytes whose digest is not the trade's");

  const rebuilt = await runTrade(
    { api: api({ status: 201, body: trade({ network_fee: { payer: "wallet", label: "Paid from your SUI" }, reservation_id: null }) }), client: fullnode(executed), signer: signer({ returnBytes: toBase64(other) }) },
    request,
  );
  assert.equal(rebuilt.status, "failed");
  assert.equal(rebuilt.status === "failed" ? rebuilt.message : "", `${TRADE_BYTES_CHANGED} Code: invalid_response.`);
  assert.deepEqual(executed, [], "nothing reached the fullnode");
});

test("the fee prompt, a refused trade and a replayed one each end without signing", async () => {
  const wallet = signer();
  const prompt = await runTrade(
    { api: api({ status: 409, body: { error: { code: "sponsorship_unavailable", message: "x", fee_mist: "1500000" } } }), client: fullnode(), signer: wallet },
    request,
  );
  assert.deepEqual(prompt, { status: "fee_required", feeMist: "1500000" });

  const short = trade({ status: "failed", failure_code: "insufficient_balance", transaction_bytes: null, digest: null, network_fee: null, reservation_id: null });
  assert.deepEqual(
    await runTrade({ api: api({ status: 201, body: short }), client: fullnode(), signer: wallet }, request),
    { status: "failed", message: "Not enough funds. Check the sell-token balance and native SUI for the network fee. Code: insufficient_balance.", code: "insufficient_balance", trade: short },
  );
  const moved = { ...short, failure_code: "price_moved" as const };
  assert.deepEqual(
    await runTrade({ api: api({ status: 201, body: moved }), client: fullnode(), signer: wallet }, request),
    { status: "failed", message: `${TRADE_FAILED} Code: price_moved.`, code: "price_moved", trade: moved },
  );
  const done = trade({ status: "confirmed", amount_out_filled: "1", transaction_bytes: null });
  assert.deepEqual(await runTrade({ api: api({ status: 200, body: done }), client: fullnode(), signer: wallet }, request), { status: "traded", trade: done });
  assert.deepEqual(wallet.signed, [], "a prompt, a refusal or a replay signs nothing");
});

test("a trade the chain does not show yet is pending after the settle reads; one that aborted is That didn’t go through", async () => {
  const pending = await runTrade({ api: api({ status: 201, body: trade() }, [trade()]), client: fullnode(), signer: signer() }, request);
  assert.equal(pending.status, "pending");
  const aborted = trade({ status: "failed", failure_code: "execution_failed", transaction_bytes: null });
  const failed = await runTrade({ api: api({ status: 201, body: trade() }, [aborted]), client: fullnode(), signer: signer() }, request);
  assert.deepEqual(failed, { status: "failed", message: `${TRADE_FAILED} Code: execution_failed.`, code: "execution_failed", trade: aborted });
});

test("malformed transaction bytes fail before the wallet is asked to sign", async () => {
  const malformed = trade({ transaction_bytes: "%not base64%" });
  const wallet = signer();
  const executed: Uint8Array[] = [];
  const result = await runTrade({ api: api({ status: 201, body: malformed }), client: fullnode(executed), signer: wallet }, request);
  assert.deepEqual(result, { status: "failed", message: `${TRADE_BYTES_UNEXPECTED} Code: invalid_response.`, code: null, trade: malformed });
  assert.deepEqual(wallet.signed, []);
  assert.deepEqual(executed, []);
});


test("wallet signing failures stay distinct from cancellation and never execute or settle", async () => {
  for (const error of [new Error("private wallet provider token"), new PublicError("Your wallet could not sign. Reconnect it and retry.", { code: "sign_failed", requestId: "wallet-sign-reference" })]) {
    const calls: Call[] = [];
    const executed: Uint8Array[] = [];
    const phases: string[] = [];
    const result = await runTrade({
      api: api({ status: 201, body: trade() }, [], calls),
      client: fullnode(executed),
      signer: { fee: "sponsored", address: WALLET, async signTransaction() { throw error; } },
      onPhase: (phase) => phases.push(phase),
    }, request);
    assert.equal(result.status, "failed");
    assert.ok(result.status === "failed");
    assert.equal(result.code, "sign_failed");
    assert.equal(result.message, error instanceof PublicError ? error.message : "Your wallet could not sign. Reconnect it and retry. Nothing was sent. Code: sign_failed.");
    assert.doesNotMatch(result.message, /private wallet provider token|You didn’t confirm/);
    assert.deepEqual(result.trade, trade(), "the original trade and digest remain available");
    assert.deepEqual(calls.map((call) => call.url), [SOCIAL_TRADES_PATH], "no sponsor execute or settle runs before signing succeeds");
    assert.deepEqual(executed, []);
    assert.deepEqual(phases, ["preparing", "signing"]);
  }
});

test("a signed trade the server answers busy (503) is sent again with the same signature, then settles", async () => {
  const calls: Call[] = [];
  const base = api({ status: 201, body: trade() }, [trade({ status: "confirmed", amount_out_filled: trade().amount_out, transaction_bytes: null })], calls);
  let executes = 0;
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/execute") && executes++ === 0) {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ error: { code: "service_unavailable", message: "busy" } }, { status: 503, headers: { "retry-after": "1" } });
    }
    return base.fetch(url, init);
  }) as typeof globalThis.fetch;
  const result = await runTrade({ api: { ...base, fetch }, client: fullnode(), signer: signer() }, request);
  assert.equal(result.status, "traded");
  const sent = calls.filter((call) => call.url.endsWith("/execute"));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0]?.body, sent[1]?.body, "the same signature both times");
});
