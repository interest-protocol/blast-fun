import assert from "node:assert/strict";
import test from "node:test";
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { setTimeout as pause } from "node:timers/promises";
import type { QueryResultRow } from "pg";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { COIN_METADATA_SQL } from "@blast/server/modules/social/portfolio/coin-metadata.ts";
import { evaluateSponsorPolicy } from "@blast/core/modules/sponsor/policy.ts";
import { claimTestIdentity } from "../../../../test/fixtures/modules/social/claims/claim-fixtures.ts";
import { AGGREGATOR_PACKAGE, balanceKey, offlineTradeChain, replayRouter, SALE_B, SENDER, SUI, TEST_BLAST_FEE, USDC, simulationAbort } from "../../../../test/fixtures/modules/social/trades/fixtures.ts";
import { minOut } from "@blast/core/modules/social/trades/amounts.ts";
import type { TradeRouter } from "@blast/server/modules/social/trades/aggregator.ts";
import { recordedAftermathRouter, YUM, YUM_POOL } from "../../../../test/fixtures/modules/social/trades/aftermath-fixtures.ts";
import { sealTradeQuote, tradeQuoteKey } from "@blast/server/modules/social/trades/quote-token.ts";
import { swapCommitTransaction } from "@blast/server/modules/social/commit/swap.ts";
import { createSocialCommitRoutes } from "@blast/server/modules/social/commit/route.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { socialErrorResponse, type SocialCaller, type SocialRequestContext, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";

const WAL = `0x${"a".repeat(64)}::wal::WAL`;
const DEEP = `0x${"b".repeat(64)}::deep::DEEP`;
const KEY = tradeQuoteKey("presale-swap-test-pepper-at-least-32-characters");
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const NOW = 1_800_000_000_000;
const IDENTITY = claimTestIdentity();
const PRESALE = `0x${"c".repeat(64)}`;
const database: ReadableDatabase = {
  async read<Row extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
    const rows = sql === COIN_METADATA_SQL ? (values?.[0] as string[]).map((coin_type) => ({ coin_type, name: "Wallet coin", symbol: "WAL", decimals: 9, icon_url: null, is_presale: false })) : [];
    return { rows: rows as unknown as Row[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
  },
};

async function fixture(coin = WAL, options: { failed?: boolean; balance?: bigint; router?: TradeRouter; quoteType?: string; gas?: bigint; held?: bigint } = {}) {
  const router = options.router ?? replayRouter(undefined, TEST_BLAST_FEE).router;
  const found = await router.findRoute({ from: options.router ? coin : SUI, target: USDC, amount: options.router ? 100_000_000_000_000_000n : 1_000_000_000n, byAmountIn: true,
    ...(options.router ? { aftermath: { coinType: YUM, poolId: YUM_POOL } } : {}) });
  assert.equal(found.status, "route");
  if (found.status !== "route") throw new Error("missing fixture route");
  // Exercise generic input types with the recorded router's real SDK command shape.
  const route = options.router ? found.route : { ...found.route, paths: found.route.paths.map((path) => ({ ...path, from: coin, target: options.quoteType ?? path.target })) };
  const minimum = minOut(route.amountOut, 50);
  const quote = { accountId: ACCOUNT, sender: SENDER, side: "sell" as const, inCoin: coin, outCoin: options.quoteType ?? USDC, amountIn: route.amountIn, amountOut: route.amountOut, minOut: minimum, slippageBps: 50, priceImpactBps: 0, blastFeeBps: 50, issuedAtMs: NOW, expiresAtMs: NOW + 20_000, route };
  const chain = offlineTradeChain({ balances: { [balanceKey(SENDER, coin)]: options.balance ?? route.amountIn, ...(options.gas ? { [balanceKey(SENDER, SUI)]: options.gas } : {}), ...(options.held ? { [balanceKey(SENDER, USDC)]: options.held } : {}) }, ...(options.failed ? { simulation: () => simulationAbort(AGGREGATOR_PACKAGE, "errors", 1) } : {}) });
  const dependencies = { database: () => database, router: () => router, chain: () => chain, quoteKey: () => KEY, now: () => NOW };
  const input = { identity: IDENTITY, presale: { objectId: PRESALE, initialSharedVersion: "3" }, saleToken: SALE_B, quoteType: options.quoteType ?? USDC, atoms: minimum, recipient: SENDER, quoteId: sealTradeQuote(KEY, quote), accountId: ACCOUNT, sender: SENDER };
  return { quote, chain, dependencies, input };
}

test("WAL and DEEP swap into an exact USDC commitment in one sponsored transaction, including allowlisted sales", async () => {
  for (const coin of [WAL, DEEP]) for (const route of ["open", "allowlisted", "uncapped"] as const) {
    const allowlist = route === "allowlisted" ? { wallet: SENDER, index: 0n, walletCap: 10_000_000_000n, proof: [] } : null;
    const { dependencies, input, chain, quote } = await fixture(coin);
    const tx = await swapCommitTransaction(dependencies, { ...input, allowlist, uncapped: route === "uncapped" });
    const kind = bcs.TransactionKind.parse(await tx.build({ client: chain.client, onlyTransactionKind: true }));
    const commands = kind.ProgrammableTransaction!.commands;
    const confirmation = commands.findIndex((command) => command.MoveCall?.function === "confirm_swap_v3");
    const commit = commands.findIndex((command) => command.MoveCall?.function === (`commit_${route}`));
    assert.ok(confirmation >= 0 && commit > confirmation);
    assert.deepEqual(commands[commit]!.MoveCall!.typeArguments, [SALE_B, USDC]);
    // commit_open/commit_allowlisted(presale, package_version, quote_in, ...): the coin is argument 2.
    const argument = commands[commit]!.MoveCall!.arguments[2]!;
    const split = commands[argument.NestedResult![0]]!.SplitCoins!;
    const amount = kind.ProgrammableTransaction!.inputs[split.amounts[0]!.Input!]!.Pure!.bytes;
    assert.equal(BigInt(bcs.u64().parse(Buffer.from(amount, "base64"))), input.atoms, "commit exactly the guaranteed USDC minimum");
    assert.equal(commands.at(-1)!.TransferObjects!.objects.length, 2, "return surplus USDC and any presale change");
    const facts = { presalePackageId: IDENTITY.presale.packageId, saleToken: SALE_B, quote: USDC, rewardRounds: [], swapTargets: [{ packageId: AGGREGATOR_PACKAGE, module: "router" }, ...quote.route.paths.map((path) => ({ packageId: path.publishedAt, module: path.provider.toLowerCase() }))], commitSwapFee: TEST_BLAST_FEE };
    assert.deepEqual(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: PRESALE, sender: SENDER, facts }), { allowed: true });
    assert.equal(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: PRESALE, sender: SENDER, facts: { ...facts, commitSwapFee: { ...TEST_BLAST_FEE, receiver: "0x123" } } }).allowed, false);
    assert.equal(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: PRESALE, sender: SENDER, facts: { ...facts, commitSwapFee: { ...TEST_BLAST_FEE, ppm: 1 } } }).allowed, false);
    assert.equal(chain.log.filter((entry) => entry.kind === "simulate").length, 1);
  }
});

test("an Aftermath DAO-fee coin can also fund a sponsored commitment; only a fee split from swap output may reach Blast", async () => {
  const { dependencies, input, chain, quote } = await fixture(YUM, { router: recordedAftermathRouter(TEST_BLAST_FEE) });
  const tx = await swapCommitTransaction(dependencies, input);
  const kind = bcs.TransactionKind.parse(await tx.build({ client: chain.client, onlyTransactionKind: true }));
  const facts = { presalePackageId: IDENTITY.presale.packageId, saleToken: SALE_B, quote: USDC, rewardRounds: [], swapTargets: [{ packageId: AGGREGATOR_PACKAGE, module: "router" }, ...quote.route.paths.map((path) => ({ packageId: path.publishedAt, module: path.provider.toLowerCase() }))], commitSwapFee: TEST_BLAST_FEE };
  assert.deepEqual(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: PRESALE, sender: SENDER, facts }), { allowed: true });
  const commands = kind.ProgrammableTransaction!.commands;
  const feeTransfer = commands.find((command) => command.TransferObjects && command !== commands.at(-1))!.TransferObjects!;
  feeTransfer.objects = commands.at(-1)!.TransferObjects!.objects;
  assert.equal(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: PRESALE, sender: SENDER, facts }).allowed, false, "the fee receiver cannot take the presale's change");
});

test("a payment quote is bound to its wallet, account, USDC amount, fee and lifetime", async () => {
  const { dependencies, input, quote } = await fixture();
  for (const changed of [{ expiresAtMs: NOW }, { accountId: "another-account" }, { sender: "0x123" }, { outCoin: SUI }, { minOut: quote.minOut + 1n }, { blastFeeBps: 0 }]) {
    await assert.rejects(swapCommitTransaction(dependencies, { ...input, quoteId: sealTradeQuote(KEY, { ...quote, ...changed }) }), { code: "commit_unavailable" });
  }
  await assert.rejects(swapCommitTransaction(dependencies, { ...input, quoteId: "tampered" }), { code: "commit_unavailable" });
});

test("missing payment funds or a failed combined swap and presale simulation refuses before signing", async () => {
  const short = await fixture(WAL, { balance: 0n });
  await assert.rejects(swapCommitTransaction(short.dependencies, short.input), { code: "insufficient_balance" });
  const failed = await fixture(DEEP, { failed: true });
  await assert.rejects(swapCommitTransaction(failed.dependencies, failed.input), { code: "commit_unavailable" });
});

test("WAL can fund TSUI and SUI presales; the sealed output must match the exact on-chain quote type", async () => {
  for (const quoteType of [SUI, `0x${"9".repeat(64)}::test_sui::TEST_SUI`]) {
    const { dependencies, input, chain, quote } = await fixture(WAL, { quoteType });
    const tx = await swapCommitTransaction(dependencies, input);
    const kind = bcs.TransactionKind.parse(await tx.build({ client: chain.client, onlyTransactionKind: true }));
    const commit = kind.ProgrammableTransaction!.commands.find((command) => command.MoveCall?.function === "commit_open")!.MoveCall!;
    assert.deepEqual(commit.typeArguments, [SALE_B, quoteType]);
    const split = kind.ProgrammableTransaction!.commands[commit.arguments[2]!.NestedResult![0]]!.SplitCoins!;
    const bytes = kind.ProgrammableTransaction!.inputs[split.amounts[0]!.Input!]!.Pure!.bytes;
    assert.equal(BigInt(bcs.u64().parse(Buffer.from(bytes, "base64"))), input.atoms);
    const facts = { presalePackageId: IDENTITY.presale.packageId, saleToken: SALE_B, quote: quoteType, rewardRounds: [], swapTargets: [{ packageId: AGGREGATOR_PACKAGE, module: "router" }, ...quote.route.paths.map((path) => ({ packageId: path.publishedAt, module: path.provider.toLowerCase() }))], commitSwapFee: TEST_BLAST_FEE };
    assert.deepEqual(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: PRESALE, sender: SENDER, facts }), { allowed: true });
    await assert.rejects(swapCommitTransaction(dependencies, { ...input, quoteType: USDC }), { code: "commit_unavailable" });
  }
});


test("a failed gas-price sibling retains the actual transaction build until it settles", async (t) => {
  const { dependencies } = await fixture();
  const { input } = await fixture();
  const failure = new Error("synthetic gas-price failure");
  let release!: () => void;
  let building = false;
  let settled = false;
  const held = new Promise<Uint8Array>((resolve) => { release = () => resolve(new Uint8Array()); });
  const build = t.mock.method(Transaction.prototype, "build", async () => {
    building = true;
    return held;
  });
  const chain = dependencies.chain();
  const running = swapCommitTransaction({ ...dependencies, chain: () => ({ ...chain, referenceGasPrice: async () => { throw failure; } }) }, input);
  const outcome = running.then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
  try {
    for (let attempt = 0; attempt < 100 && !building; attempt++) await pause(1);
    assert.equal(building, true);
    await pause(5);
    assert.equal(settled, false, "physical ownership outlives a sibling refusal");
    release();
    assert.equal(await outcome, failure);
  } finally {
    release();
    await outcome;
    build.mock.restore();
  }
});

/** The commit route over the swap fixture: a signed-in account, the caller's Blast wallet, and an in-process sponsor. */
async function routeFixture(caller: SocialCaller, sponsor: ((request: unknown) => Promise<unknown>) | null) {
  const { dependencies, input, chain } = await fixture(WAL, { gas: 1_000_000_000n, held: 1_000_000_000n });
  const kit: SocialRouteKit = {
    route(_spec, handle) {
      return async (request, client) => {
        const context = {
          request, requestId: "swap-commit", client, account: { account_id: ACCOUNT }, trading: false, hiddenKinds: [],
          caller,
          json: (body: unknown, status = 200) => Response.json(body, { status }),
          consume: async () => {},
          consumeAccount: async () => {},
          transaction: async () => { throw new Error("no database transaction"); },
        } as unknown as SocialRequestContext;
        try {
          return await handle(context);
        } catch (error) {
          if (error instanceof SocialRouteError) return socialErrorResponse(context.requestId, error, "private, no-store");
          throw error;
        }
      };
    },
  };
  const sponsored: unknown[] = [];
  const route = createSocialCommitRoutes({
    kit,
    deployment: async () => IDENTITY,
    chain: () => ({
      presale: async () => ({ objectId: PRESALE, initialSharedVersion: "3", saleToken: SALE_B, quote: USDC, allowlisted: false, publicFromMs: null, endMs: 0n }),
      balance: async () => input.atoms,
      kind: (transaction, sender) => { transaction.setSenderIfNotSet(sender); return transaction.build({ client: chain.client, onlyTransactionKind: true }); },
    }),
    blastWallet: async () => SENDER,
    swap: dependencies,
    ...(sponsor ? { sponsor: () => ({ sponsorServerCommit: async (request) => { sponsored.push(request); return sponsor(request) as never; } }) } : {}),
  });
  const build = (swap = true) => route.build(new Request("https://blast.test/api/social/me/commits", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ presale_id: PRESALE, pay_with: "QUOTE", amount: input.atoms.toString(), ...(swap ? { swap_quote_id: input.quoteId } : {}) }),
  }), testClient());
  return { build, sponsored };
}

const PRIVY: SocialCaller = { kind: "privy", did: "did:privy:test", subject: "did:privy:test" };

test("a Blast wallet's swap-and-commit comes back already sponsored, for exactly the kind it built", async () => {
  const reservation = { reservation_id: "reservation-1", transaction_bytes: "AAAA", sponsor_signature: "", expires_at_ms: NOW + 60_000, gas_budget: "1" };
  const { build, sponsored } = await routeFixture(PRIVY, async () => reservation);
  const response = await build();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.sponsored, { reservation_id: "reservation-1", transaction_bytes: "AAAA", expires_at_ms: NOW + 60_000 });
  assert.equal(sponsored.length, 1);
  const request = sponsored[0] as { intent: string; presaleId: string; sender: string; caller: SocialCaller; kindBytes: Uint8Array };
  assert.equal(request.intent, "commit");
  assert.equal(request.presaleId, PRESALE);
  assert.equal(request.sender, SENDER);
  assert.deepEqual(request.caller, PRIVY);
  assert.equal(Buffer.from(request.kindBytes).toString("base64"), body.transaction_kind_bytes);
});

test("a wallet session's swap-and-commit is sponsored too, as that session (owner ruling 2026-11-20)", async () => {
  const wallet: SocialCaller = { kind: "wallet", address: SENDER, subject: `sui:${SENDER}` };
  const reservation = { reservation_id: "reservation-2", transaction_bytes: "AAAA", sponsor_signature: "", expires_at_ms: NOW + 60_000, gas_budget: "1" };
  const { build, sponsored } = await routeFixture(wallet, async () => reservation);
  const response = await build();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sponsored.reservation_id, "reservation-2");
  assert.equal(sponsored.length, 1);
  assert.deepEqual((sponsored[0] as { caller: SocialCaller }).caller, wallet);
});

test("a sponsor refusal of a swap-and-commit answers in the commit route's words", async () => {
  for (const [code, status, published] of [
    ["rate_limited", 429, "rate_limited"],
    ["budget_exceeded", 429, "rate_limited"],
    ["dry_run_failed", 409, "commit_unavailable"],
    ["service_unavailable", 503, "service_unavailable"],
    ["not_embedded_wallet", 409, "blast_wallet_missing"],
  ] as const) {
    const { build } = await routeFixture(PRIVY, async () => { throw new PresaleRouteError(code, code === "rate_limited" || code === "budget_exceeded" ? { retryAfterSeconds: 7 } : {}); });
    const response = await build();
    assert.equal(response.status, status, code);
    if (published === "rate_limited") assert.equal(response.headers.get("retry-after"), "7");
    if (published === "service_unavailable") assert.ok(Number(response.headers.get("retry-after")) > 0);
    const body = await response.json();
    assert.equal(body.error.code, published, code);
    if (code === "dry_run_failed") assert.deepEqual(body.error.reasons, ["swap_unavailable"]);
  }
});

test("only a swap-and-commit is sponsored in the build; without the in-process sponsor it is refused as unroutable", async () => {
  const plain = await routeFixture(PRIVY, async () => { throw new Error("a plain commit is sponsored by the browser's own request"); });
  const response = await plain.build(false);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sponsored, undefined);
  assert.equal(plain.sponsored.length, 0);

  const missing = await routeFixture(PRIVY, null);
  const refused = await missing.build();
  assert.equal(refused.status, 409);
  assert.deepEqual((await refused.json()).error.reasons, ["swap_unavailable"]);
});
