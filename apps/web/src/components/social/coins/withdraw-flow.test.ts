import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { fastTimeouts } from "../../../../test/fixtures/social/fast-timeouts.ts";
beforeEach(() => fastTimeouts());
afterEach(() => mock.restoreAll());

import { bcs } from "@mysten/sui/bcs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { TransactionDataBuilder, Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { selectedAccountSession, switchAccountSession } from "../account-selection.ts";
import type { TransactionSigner } from "#web/components/social/sponsored-transaction.ts";
import { readSponsoredBytes, sponsoredWalletSigner } from "#web/lib/sui-signing.ts";
import { clearWithdrawReceipt, saveWithdrawReceipt } from "./withdraw-attempt.ts";
import { refusalMessage, runWithdraw, withdrawTransaction, type WithdrawSigner } from "./withdraw-flow";

/**
 * Social UI-14: one withdrawal end to end against fakes: the social routes and
 * the presale sponsor answered from a script, the wallet's coins from an
 * in-memory client. Nothing reaches a chain.
 */

const SENDER = `0x${"1a".repeat(32)}`;
const RECIPIENT = `0x${"a3".repeat(32)}`;
const REQUEST = "0d2c4ab1-6c6f-4c1e-9d2a-7a1b2c3d4e5f";
const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const OBJECT_DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

/** The wallet's coins of any type: one object of 1,000 coins (6 decimals). */
const client = {
  core: {
    resolveTransactionPlugin: () => undefined,
    getBalance: async ({ coinType }: { coinType: string }) => ({ balance: { coinType, balance: "1000000000", coinBalance: "1000000000", addressBalance: "0" } }),
    listCoins: async ({ coinType }: { coinType: string }) => ({
      objects: [{ objectId: `0x${"d0".repeat(32)}`, version: "11", digest: OBJECT_DIGEST, balance: "1000000000", type: `0x2::coin::Coin<${coinType}>` }],
      hasNextPage: false,
      cursor: null,
    }),
  },
} as unknown as ClientWithCoreApi;

type Call = Readonly<{ method: string; path: string; body: Record<string, unknown> | null }>;

/** A scripted `fetch`: each route answers from `answers` in order; every call is recorded. */
function routes(answers: Record<string, ((body: Record<string, unknown>) => [number, unknown])[]>) {
  const calls: Call[] = [];
  const fetch = (async (path: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const key = `${init.method} ${path.replace(REQUEST, "{id}").replace(/sponsor\/[^/]+\/execute/, "sponsor/{r}/execute")}`;
    calls.push({ method: String(init.method), path, body });
    const next = answers[key]?.shift();
    if (!next) throw new Error(`no answer for ${key}`);
    const [status, answer] = next(body ?? {});
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const transfer = (status: string, digest: string | null, failure: string | null = null) => (body: Record<string, unknown>): [number, unknown] => [
  status === "pending" ? 201 : status === "submitted" ? 202 : 200,
  { request_id: REQUEST, coin_type: body.coin_type, amount: body.amount, recipient: body.recipient, fee: "sponsored", status, digest, failure, created_at_ms: 1, settled_at_ms: null },
];

/** What the sponsor would answer: the caller's kind with gas data around it. */
const sponsor = (mutate?: (kind: Uint8Array) => Uint8Array) => (body: Record<string, unknown>): [number, unknown] => {
  const kind = fromBase64(String(body.transaction_kind_bytes));
  const bytes = bcs.TransactionData.serialize({
    V1: {
      kind: bcs.TransactionKind.parse(mutate ? mutate(kind) : kind),
      sender: String(body.sender),
      gasData: { payment: [], owner: `0x${"5b".repeat(32)}`, price: "1000", budget: "2000000" },
      expiration: { None: true },
    },
  }).toBytes();
  return [200, { reservation_id: "6f1a5c2e-1111-4222-8333-944445555666", transaction_bytes: toBase64(bytes), sponsor_signature: "", expires_at_ms: 9, gas_budget: "2000000" }];
};

function sponsoredSigner(signed: Uint8Array[]): WithdrawSigner {
  return { fee: "sponsored", address: SENDER, signTransaction: async (bytes) => (signed.push(bytes), "AAAA") };
}

const request = { requestId: REQUEST, coinType: SUI_COIN_TYPE, atoms: 100_000_000n, recipient: RECIPIENT };

/** Prepared wallet bytes, with gas chosen by the builder rather than the wallet. */
const buildWalletTransaction = async (transaction: Transaction): Promise<Uint8Array> => {
  const gas = transaction.getData().gasData;
  return bcs.TransactionData.serialize({ V1: {
    kind: { ProgrammableTransaction: { inputs: [], commands: [] } }, sender: SENDER,
    gasData: { payment: [], owner: SENDER, price: gas.price ?? "1000", budget: gas.budget ?? "2000000" },
    expiration: transaction.getData().expiration ?? { None: true },
  } }).toBytes();
};

const nativeBuild = Transaction.prototype.build;
beforeEach(() => mock.method(Transaction.prototype, "build", async function (this: Transaction, options: Parameters<Transaction["build"]>[0]) {
  return options?.onlyTransactionKind || options?.client instanceof SuiGrpcClient ? nativeBuild.call(this, options) : buildWalletTransaction(this);
}));

/** A wallet session's own signer, put on Blast's gas the way `blastWalletSigner` does. */
const walletSession = (signTransaction: Extract<TransactionSigner, { fee: "wallet" }>["signTransaction"]): WithdrawSigner =>
  sponsoredWalletSigner({ fee: "wallet", address: SENDER, signTransaction });

const walletClient = (executeTransaction: (input: Readonly<{ transaction: Uint8Array; signatures: readonly string[] }>) => Promise<unknown>) => ({
  core: {
    ...client.core,
    getCurrentSystemState: async () => ({ systemState: { epoch: "100" } }),
    getChainIdentifier: async () => ({ chainIdentifier: DIGEST }),
    executeTransaction,
  },
}) as unknown as ClientWithCoreApi;


test("native USDC withdrawal uses balance::send_funds with no gas payment", () => {
  const data = withdrawTransaction({ ...request, coinType: USDC_COIN_TYPE }, SENDER).getData();
  assert.equal(data.gasData.price, "0");
  assert.equal(data.gasData.budget, "0");
  assert.deepEqual(data.gasData.payment, []);
  assert.ok(data.commands.some((command) => command.MoveCall?.module === "balance" && command.MoveCall.function === "send_funds"));
  assert.equal(data.commands.some((command) => command.TransferObjects), false);
});

test("only a confirmed withdrawal balance shortage asks for a balance refresh", async (t) => {
  const shortage = `Insufficient balance of ${USDC_COIN_TYPE} for owner ${SENDER}. Required: 100000000, Available: 1`;
  let message = shortage;
  t.mock.method(Transaction.prototype, "build", async () => { throw new Error(message); });
  const { fetch, calls } = routes({ "PUT /api/social/me/transfers/{id}": [transfer("pending", null), transfer("pending", null)] });
  const signed: Uint8Array[] = [];
  const deps = { api: { getAccessToken: async () => null, fetch }, client: walletClient(async () => { throw new Error("withdrawal must stay unsigned"); }), signer: sponsoredSigner(signed) };
  const result = await runWithdraw(deps, { ...request, coinType: USDC_COIN_TYPE });
  assert.equal(result.status === "failed" && result.balanceChanged, true);
  message = "Connection lost";
  const unavailable = await runWithdraw(deps, request);
  assert.equal(unavailable.status === "failed" && unavailable.balanceChanged, undefined);
  assert.deepEqual(signed, []);
  assert.equal(calls.length, 2);
});

test("gasless USDC builds from coins or address balances, signs and executes directly, and retries only settle", async (t) => {
  for (const addressBalance of ["0", "1000000000"]) {
    const grpc = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });
    t.mock.method(grpc.core, "getBalance", async ({ coinType }: { coinType: string }) => ({
      balance: { coinType, balance: "1000000000", coinBalance: addressBalance === "0" ? "1000000000" : "0", addressBalance },
    }));
    t.mock.method(grpc.core, "listCoins", async ({ coinType }: { coinType: string }) => addressBalance === "0"
      ? client.core.listCoins({ owner: SENDER, coinType })
      : { objects: [], hasNextPage: false, cursor: null });
    t.mock.method(grpc.core, "getCurrentSystemState", async () => ({ systemState: { epoch: "100", referenceGasPrice: "1000" } }));
    t.mock.method(grpc.core, "getChainIdentifier", async () => ({ chainIdentifier: DIGEST }));
    t.mock.method(grpc.transactionExecutionService, "simulateTransaction", async (input: Parameters<typeof grpc.transactionExecutionService.simulateTransaction>[0]) => {
      assert.equal(input.doGasSelection, false);
      if (addressBalance !== "0" && input.transaction?.expiration?.kind !== 3) {
        throw new Error("Invalid transaction expiration: expected ValidDuring");
      }
      return { response: { transaction: { transaction: input.transaction, effects: { status: { success: true }, epoch: 100n } } } };
    });
    const signed: Uint8Array[] = [];
    const submitted: Uint8Array[] = [];
    t.mock.method(grpc.core, "executeTransaction", async (input: { transaction: Uint8Array; signatures: string[] }) => {
      assert.deepEqual(input.signatures, ["AAAA"]);
      submitted.push(input.transaction);
      throw new Error("connection lost after submission");
    });
    const pending = (body: Record<string, unknown>) => transfer("submitted", String(body.digest))(body);
    const { fetch, calls } = routes({
      "PUT /api/social/me/transfers/{id}": [transfer("pending", null), ...Array.from({ length: 5 }, () => pending), pending, (body) => transfer("confirmed", String(body.digest))(body)],
    });
    let knownDigest: string | null = null;
    const deps = { api: { getAccessToken: async () => "t", fetch }, client: grpc, signer: sponsoredSigner(signed), onDigest: (digest: string) => { knownDigest = digest; } };
    const usdc = { ...request, coinType: USDC_COIN_TYPE, atoms: addressBalance === "0" ? request.atoms : 1_000_000_000n };
    const result = await runWithdraw(deps, usdc);
    assert.equal(result.status, "pending", result.status === "failed" ? result.message : undefined);
    assert.equal(signed.length, 1);
    assert.deepEqual(submitted, signed);
    const data = bcs.TransactionData.parse(signed[0]!).V1!;
    assert.deepEqual(data.gasData, { payment: [], owner: SENDER, price: "0", budget: "0" });
    const expiry = data.expiration.ValidDuring;
    assert.ok(expiry, "gasless transfers retain replay protection");
    assert.deepEqual([expiry.minEpoch, expiry.maxEpoch, expiry.chain], ["100", "101", DIGEST]);
    const commands = data.kind.ProgrammableTransaction!.commands;
    assert.equal(commands.some((command) => command.TransferObjects), false);
    assert.ok(commands.some((command) => command.MoveCall?.module === "balance" && command.MoveCall.function === "send_funds"));
    if (addressBalance === "0") {
      assert.ok(commands.some((command) => command.MoveCall?.module === "coin" && command.MoveCall.function === "send_funds"), "the leftover coin is consumed into the sender's address balance");
    }
    assert.equal((await runWithdraw({ ...deps, knownDigest }, usdc)).status, "sent");
    assert.equal(submitted.length, 1);
    assert.equal(signed.length, 1);
    assert.ok(calls.every((call) => call.method === "PUT"), "no gas pool request");
  }
});

test("switching during a gasless withdrawal preserves its digest so the original account can retry without sending twice", async (t) => {
  const key = "privy-withdrawal";
  const stored = new Map<string, string>();
  let reloads = 0;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const browser = {
    document: { cookie: "blast_active_account=privy" },
    location: { protocol: "https:", reload: () => { reloads += 1; } },
    sessionStorage: {
      getItem: (name: string) => stored.get(name) ?? null,
      setItem: (name: string, value: string) => { stored.set(name, value); },
      removeItem: (name: string) => { stored.delete(name); },
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  t.after(() => {
    clearWithdrawReceipt(key);
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: browser.document });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });

  const broadcasting = Promise.withResolvers<boolean>();
  const finishBroadcast = Promise.withResolvers<void>();
  const signed: Uint8Array[] = [];
  const mockNode = walletClient(async () => {
    broadcasting.resolve(switchAccountSession("wallet"));
    await finishBroadcast.promise;
    throw new Error("Connection lost after submission");
  });
  const confirmed = (body: Record<string, unknown>) => transfer("confirmed", String(body.digest))(body);
  const { fetch, calls } = routes({
    "PUT /api/social/me/transfers/{id}": [transfer("pending", null), () => [503, {}], confirmed, confirmed],
  });
  const usdc = { ...request, coinType: USDC_COIN_TYPE };
  const deps = { api: { getAccessToken: async () => "t", fetch }, client: mockNode, signer: sponsoredSigner(signed) };
  const withdrawal = runWithdraw({
    ...deps, onDigest: (digest) => saveWithdrawReceipt(key, { requestId: REQUEST, digest }),
  }, usdc);
  const switchedWhileBroadcasting = await broadcasting.promise;
  finishBroadcast.resolve();
  assert.equal(switchedWhileBroadcasting, false);
  assert.equal(selectedAccountSession(browser.document.cookie), "privy");
  const pending = await withdrawal;
  assert.equal(pending.status, "pending");
  assert.equal(switchAccountSession("wallet"), true);
  assert.equal(reloads, 1);

  const reloaded: typeof import("./withdraw-attempt.ts") = await import(new URL("./withdraw-attempt.ts?reloaded", import.meta.url).href);
  const receipt = reloaded.readWithdrawReceipt(key);
  assert.ok(receipt);
  assert.deepEqual(receipt, { requestId: REQUEST, digest: pending.digest });
  const retried = await runWithdraw({ ...deps, knownDigest: receipt.digest }, { ...usdc, requestId: receipt.requestId });
  assert.equal(retried.status, "sent");
  assert.equal(signed.length, 1);
  assert.equal(calls.at(-1)?.body?.digest, pending.digest);
});

test("USDC wallet sessions receive a zero-gas transaction; sub-minimum requests never sign", async () => {
  const { fetch, calls } = routes({ "PUT /api/social/me/transfers/{id}": [transfer("pending", null), transfer("confirmed", DIGEST), transfer("pending", null), transfer("submitted", DIGEST), transfer("confirmed", DIGEST)] });
  let signed = 0;
  const signer = walletSession(async (bytes) => {
    signed += 1;
    const data = bcs.TransactionData.parse(bytes).V1!;
    assert.deepEqual(data.gasData.payment, []);
    assert.equal(data.gasData.price, "0");
    return { bytes: toBase64(bytes), signature: "AAAA" };
  });
  const deps = { api: { getAccessToken: async () => null, fetch }, client: walletClient(async () => ({ $kind: "Transaction" })), signer };
  assert.equal((await runWithdraw(deps, { ...request, coinType: USDC_COIN_TYPE, atoms: 10_000n })).status, "sent");
  assert.equal(calls.length, 2);
  assert.equal((await runWithdraw(deps, { ...request, coinType: USDC_COIN_TYPE, atoms: 9_999n })).status, "failed");
  assert.equal(signed, 1);
  assert.equal((await runWithdraw({ ...deps, knownDigest: DIGEST }, { ...request, coinType: USDC_COIN_TYPE, atoms: 9_999n })).status, "sent", "previously sent sub-minimum withdrawals still settle");
  assert.equal(signed, 1);
});

test("sponsored: record, sponsor the kind with intent withdraw, sign exactly the returned bytes, execute, settle", async () => {
  const signed: Uint8Array[] = [];
  const { calls, fetch } = routes({
    "PUT /api/social/me/transfers/{id}": [transfer("pending", null), transfer("confirmed", DIGEST)],
    "POST /api/presale/sponsor": [sponsor()],
    // The execute route answers the digest of the bytes it sponsored, the ones signed here.
    "POST /api/presale/sponsor/{r}/execute": [() => [200, { digest: TransactionDataBuilder.getDigestFromBytes(signed[0]!), effects: { status: "success", gas_used: "1" } }]],
  });
  const digests: string[] = [];
  const result = await runWithdraw(
    { api: { getAccessToken: async () => "privy-token", fetch }, client, signer: sponsoredSigner(signed), onDigest: (d) => digests.push(d) },
    request,
  );
  assert.equal(result.status, "sent");
  const digest = TransactionDataBuilder.getDigestFromBytes(signed[0]!);
  assert.deepEqual(digests, [digest]);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    `PUT /api/social/me/transfers/${REQUEST}`,
    "POST /api/presale/sponsor",
    "POST /api/presale/sponsor/6f1a5c2e-1111-4222-8333-944445555666/execute",
    `PUT /api/social/me/transfers/${REQUEST}`,
  ]);
  assert.deepEqual(calls[0]!.body, { coin_type: SUI_COIN_TYPE, amount: "100000000", recipient: RECIPIENT });
  assert.deepEqual(Object.keys(calls[1]!.body!).sort(), ["intent", "sender", "transaction_kind_bytes"]);
  assert.equal(calls[1]!.body!.intent, "withdraw");
  assert.deepEqual(calls[3]!.body, { coin_type: SUI_COIN_TYPE, amount: "100000000", recipient: RECIPIENT, digest, transaction_bytes: toBase64(signed[0]!) });
  assert.equal(signed.length, 1);
  // The kind sent is a transfer of a split of the sender's coin to the recipient, never the gas coin.
  const kind = bcs.TransactionKind.parse(fromBase64(String(calls[1]!.body!.transaction_kind_bytes)));
  const commands = kind.ProgrammableTransaction!.commands.map((command) => command.$kind);
  assert.ok(commands.includes("SplitCoins") && commands.at(-1) === "TransferObjects", String(commands));
});

test("sponsored: bytes that are not the sent kind are never signed", async () => {
  const signed: Uint8Array[] = [];
  const { fetch } = routes({
    "PUT /api/social/me/transfers/{id}": [transfer("pending", null)],
    "POST /api/presale/sponsor": [sponsor(() => bcs.TransactionKind.serialize({ ProgrammableTransaction: { inputs: [], commands: [] } }).toBytes())],
  });
  const result = await runWithdraw({ api: { getAccessToken: async () => "t", fetch }, client, signer: sponsoredSigner(signed) }, request);
  assert.deepEqual(result, { status: "failed", message: "Blast returned a different transaction. Nothing was signed. Code: invalid_response.", digest: null });
  assert.equal(signed.length, 0);
});

test("a recorded digest is settled, never sent again; a refused record or sponsor stops before signing", async () => {
  const signed: Uint8Array[] = [];
  const again = routes({ "PUT /api/social/me/transfers/{id}": [transfer("submitted", DIGEST), transfer("confirmed", DIGEST)] });
  const result = await runWithdraw({ api: { getAccessToken: async () => "t", fetch: again.fetch }, client, signer: sponsoredSigner(signed) }, request);
  assert.equal(result.status, "sent");
  assert.equal(again.calls.length, 2, "no sponsor call");

  const busy = routes({
    "PUT /api/social/me/transfers/{id}": [transfer("pending", null)],
    "POST /api/presale/sponsor": [() => [503, { error: { code: "pool_unavailable", message: "x" } }]],
  });
  const refused = await runWithdraw({ api: { getAccessToken: async () => "t", fetch: busy.fetch }, client, signer: sponsoredSigner(signed) }, request);
  assert.deepEqual(refused, { status: "failed", message: "Withdrawals are paused for a moment. Nothing was sent. Try again soon. Code: pool_unavailable.", digest: null });
  const conflict = routes({ "PUT /api/social/me/transfers/{id}": [() => [409, { error: { code: "transfer_conflict", message: "x" } }]] });
  const stopped = await runWithdraw({ api: { getAccessToken: async () => "t", fetch: conflict.fetch }, client, signer: sponsoredSigner(signed) }, request);
  assert.equal(stopped.status, "failed");
  assert.equal(signed.length, 0);
});

test("a cancelled signature sends nothing; an aborted execution is reported as failed with its digest", async () => {
  const cancel = routes({ "PUT /api/social/me/transfers/{id}": [transfer("pending", null)], "POST /api/presale/sponsor": [sponsor()] });
  const signer: WithdrawSigner = { fee: "sponsored", address: SENDER, signTransaction: async () => Promise.reject(new Error("User rejected")) };
  assert.deepEqual(
    await runWithdraw({ api: { getAccessToken: async () => "t", fetch: cancel.fetch }, client, signer }, request),
    { status: "failed", message: "Withdrawal cancelled. Nothing was sent. Code: wallet_rejected.", digest: null },
  );
  const signed: Uint8Array[] = [];
  const aborted = routes({
    "PUT /api/social/me/transfers/{id}": [transfer("pending", null), transfer("failed", DIGEST, "execution_failed")],
    "POST /api/presale/sponsor": [sponsor()],
    // The execute route answers the digest of the bytes it sponsored, the ones signed here.
    "POST /api/presale/sponsor/{r}/execute": [() => [200, { digest: TransactionDataBuilder.getDigestFromBytes(signed[0]!), effects: { status: "failure", gas_used: "1" } }]],
  });
  const result = await runWithdraw({ api: { getAccessToken: async () => "t", fetch: aborted.fetch }, client, signer: sponsoredSigner(signed) }, request);
  assert.deepEqual(result, { status: "failed", message: "The withdrawal failed on Sui. Your coins did not move. Code: execution_failed.", digest: TransactionDataBuilder.getDigestFromBytes(signed[0]!) });
});

test("a SUI withdrawal never takes the sponsor's gas coin", () => {
  const sui = { coinType: SUI_COIN_TYPE, atoms: 5n, recipient: RECIPIENT };
  const intent = withdrawTransaction(sui, SENDER).getData().commands.find((command) => command.$Intent)?.$Intent?.data as { type?: string } | undefined;
  assert.equal(intent?.type, SUI_COIN_TYPE);
});

test("refusal copy and the sponsored-bytes check", () => {
  assert.equal(refusalMessage({ status: "error" }), "The withdrawal could not reach Blast. Nothing was sent. Try again. Code: request_failed.");
  assert.equal(refusalMessage({ status: "refused", code: "budget_exceeded", retryAfterSeconds: 9 }), "Too many withdrawals for now. Nothing was sent. Try again later. Code: budget_exceeded.");
  assert.equal(refusalMessage({ status: "refused", code: "dry_run_failed", retryAfterSeconds: null }), "This withdrawal would fail on Sui. Check the amount. Nothing was sent. Code: dry_run_failed.");
  assert.equal(refusalMessage({ status: "refused", code: "something_new", retryAfterSeconds: null }), "The withdrawal did not go through. Nothing was sent. Code: request_failed.");
  assert.equal(readSponsoredBytes(toBase64(Uint8Array.from([1, 2, 3])), Uint8Array.from([1]), SENDER), null);
  assert.equal(readSponsoredBytes("%not base64%", Uint8Array.from([1]), SENDER), null);
});

test("malformed withdrawal sponsor bytes fail before signing", async () => {
  const signed: Uint8Array[] = [];
  const { fetch, calls } = routes({
    "PUT /api/social/me/transfers/{id}": [transfer("pending", null)],
    "POST /api/presale/sponsor": [() => [200, { reservation_id: "r1", transaction_bytes: "%not base64%", expires_at_ms: 9 }]],
  });
  const result = await runWithdraw({ api: { getAccessToken: async () => "t", fetch }, client, signer: sponsoredSigner(signed) }, request);
  assert.deepEqual(result, { status: "failed", message: "Blast returned a different transaction. Nothing was signed. Code: invalid_response.", digest: null });
  assert.deepEqual(signed, []);
  assert.equal(calls.some((call) => call.path.endsWith("/execute")), false);
});

test("an ambiguous sponsored execute keeps its digest, and a retry only settles instead of signing again", async () => {
  for (const execute of [() => { throw new Error("connection lost after submission"); }, () => [503, { error: { code: "execution_unconfirmed" } }] as [number, unknown]]) {
    const signed: Uint8Array[] = [];
    let knownDigest: string | null = null;
    const pending = (body: Record<string, unknown>) => transfer("submitted", String(body.digest))(body);
    const { fetch, calls } = routes({
      "PUT /api/social/me/transfers/{id}": [transfer("pending", null), ...Array.from({ length: 5 }, () => pending), pending, (body) => transfer("confirmed", String(body.digest))(body)],
      "POST /api/presale/sponsor": [sponsor()],
      "POST /api/presale/sponsor/{r}/execute": [execute],
    });
    const deps = { api: { getAccessToken: async () => "t", fetch }, client, signer: sponsoredSigner(signed), onDigest: (digest: string) => { knownDigest = digest; } };
    const first = await runWithdraw(deps, request);
    assert.equal(first.status, "pending");
    assert.equal(knownDigest, TransactionDataBuilder.getDigestFromBytes(signed[0]!));
    const unavailable = routes({ "PUT /api/social/me/transfers/{id}": [() => [503, { error: { code: "service_unavailable" } }]] });
    const interrupted = await runWithdraw({ ...deps, api: { ...deps.api, fetch: unavailable.fetch }, knownDigest }, request);
    assert.equal(interrupted.status, "pending", "an unavailable status read must keep the attempt");
    assert.equal(interrupted.digest, knownDigest);
    const retried = await runWithdraw({ ...deps, knownDigest }, request);
    assert.equal(retried.status, "sent");
    assert.equal(signed.length, 1);
    assert.equal(calls.filter((call) => call.path.endsWith("/execute")).length, 1);
  }
});


for (const failure of ["changed bytes", "User rejected", "private wallet failure"] as const) {
  test(`a wallet session's USDC withdrawal ${failure} stops before submission`, async () => {
    const { fetch } = routes({ "PUT /api/social/me/transfers/{id}": [transfer("pending", null)] });
    let submitted = 0;
    let digests = 0;
    const signer = walletSession(async () => {
      if (failure === "changed bytes") return { bytes: "AAAA", signature: "AAAA" };
      throw new Error(failure);
    });
    const result = await runWithdraw({ api: { getAccessToken: async () => null, fetch }, client: walletClient(async () => { submitted += 1; return { $kind: "Transaction" }; }), signer, onDigest: () => { digests += 1; } }, { ...request, coinType: USDC_COIN_TYPE });
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.message, /Code: (invalid_response|wallet_rejected|sign_failed)\./);
      assert.doesNotMatch(result.message, /private wallet failure/);
    }
    assert.equal(result.digest, null);
    assert.equal(submitted, 0);
    assert.equal(digests, 0);
  });
}


// The SDK answers `FailedTransaction` exactly when the status is unsuccessful.
test("a direct USDC execution reports an unsuccessful transaction as failed", async () => {
  const { fetch } = routes({ "PUT /api/social/me/transfers/{id}": [transfer("pending", null), (body) => transfer("failed", String(body.digest), "execution_failed")(body)] });
  const signer = walletSession(async (bytes) => ({ bytes: toBase64(bytes), signature: "AAAA" }));
  let knownDigest: string | null = null;
  const result = await runWithdraw({ api: { getAccessToken: async () => null, fetch }, client: walletClient(async () => ({ $kind: "FailedTransaction", FailedTransaction: { status: { success: false, error: { message: "private chain payload" } } } })), signer, onDigest: (digest) => { knownDigest = digest; } }, { ...request, coinType: USDC_COIN_TYPE });
  assert.equal(result.status, "failed");
  assert.equal(result.digest, knownDigest);
  assert.ok(knownDigest);
  if (result.status === "failed") {
    assert.match(result.message, /Your coins did not move\. Code: execution_failed\./);
    assert.doesNotMatch(result.message, /private chain payload/);
  }
});
