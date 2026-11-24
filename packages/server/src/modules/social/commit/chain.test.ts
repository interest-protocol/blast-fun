import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import { evaluateSponsorPolicy } from "@blast/core/modules/sponsor/policy.ts";
import { claimTestIdentity } from "../../../../test/fixtures/modules/social/claims/claim-fixtures.ts";
import { PresaleTransactions } from "@interest-protocol/blast-sdk/presale";

import { commitTransaction, createCommitChain } from "@blast/server/modules/social/commit/chain.ts";
import { holdAddressBalance, holdCoins, stubCoin, stubCommitCore } from "../../../../../core/test/fixtures/modules/social/commit/commit-fixtures.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/**
 * The server-built commit without a network: the build the browser used to
 * run (`commitTransaction`, then the Blast wallet as sender and a kind-only
 * build with its own coins), now over the deployment's node through
 * `createCommitChain`, against a stub Core API client. The kind is the SDK's
 * own commit, and the presale sponsor's real policy takes it for its sender.
 */

const identity = claimTestIdentity();
const PACKAGE = normalizeSuiAddress(identity.presale.packageId);
const SALE = `0x${"5a1e".padStart(64, "0")}`;
const KAI = normalizeSuiAddress(`0x${"9a11e700".padStart(64, "0")}`);
const NOVA = normalizeSuiAddress(`0x${"50fa".padStart(64, "0")}`);
const TOKEN = normalizeStructTag(`0x${"c0".padStart(64, "0")}::mrdn::MRDN`);
const USDC = normalizeStructTag("0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC");
const FACTS = { presalePackageId: PACKAGE, saleToken: TOKEN, quote: USDC, rewardRounds: [], swapTargets: [] };

function fixture() {
  const core = stubCommitCore(identity);
  core.presales.set(SALE, { saleToken: TOKEN, quote: USDC, initialSharedVersion: "4242" });
  holdCoins(core, KAI, USDC, [stubCoin(1, 30_000_000n), stubCoin(2, 40_000_000n)]);
  return { core, chain: createCommitChain({ client: core.client, identity }) };
}

test("the commit kind is built on the server: the SDK's commit_open<S, Q> over the sale's shared object and the wallet's own coins, change back to the wallet", async () => {
  const { chain } = fixture();
  const presale = await chain.presale(SALE);
  assert.deepEqual(presale, { objectId: SALE, initialSharedVersion: "4242", saleToken: TOKEN, quote: USDC, allowlisted: false, publicFromMs: null, endMs: 0n });
  const transaction = commitTransaction({ identity, presale: presale!, saleToken: presale!.saleToken, quoteType: presale!.quote, atoms: 50_000_000n, recipient: KAI });
  const kind = bcs.TransactionKind.parse(await chain.kind(transaction, KAI));
  const program = kind.ProgrammableTransaction!;
  const calls = program.commands.flatMap((command) => (command.MoveCall ? [command.MoveCall] : []));
  const ours = calls.filter((call) => normalizeSuiAddress(call.package) === PACKAGE);
  assert.deepEqual(
    ours.map((call) => [call.module, call.function, call.typeArguments.map((type) => normalizeStructTag(type))]),
    [["blast_presale", "commit_open", [TOKEN, USDC]]],
  );
  const owned = program.inputs.flatMap((input) => (input.Object?.ImmOrOwnedObject ? [normalizeSuiAddress(input.Object.ImmOrOwnedObject.objectId)] : []));
  assert.deepEqual(owned.sort(), [stubCoin(1, 0n).objectId, stubCoin(2, 0n).objectId].sort(), "Kai's two USDC coins, merged and split");
  assert.ok(!program.commands.some((command) => JSON.stringify(command).includes("GasCoin")), "a USDC commit never touches the gas coin");
  // The presale sponsor's commit policy takes it from Kai, and refuses it from anyone else.
  assert.deepEqual(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: SALE, sender: KAI, facts: FACTS }), { allowed: true });
  assert.equal(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: SALE, sender: NOVA, facts: FACTS }).allowed, false);
});

test("an allowlisted commit is commit_allowlisted with the wallet's leaf, and the sponsor's policy takes it", async () => {
  const { chain } = fixture();
  const presale = (await chain.presale(SALE))!;
  const transaction = commitTransaction({
    identity,
    presale,
    saleToken: presale.saleToken,
    quoteType: presale.quote,
    atoms: 10_000_000n,
    recipient: KAI,
    allowlist: { index: 7n, wallet: KAI, walletCap: 5_000_000_000n, proof: ["01".repeat(32), "02".repeat(32)] },
  });
  const kind = bcs.TransactionKind.parse(await chain.kind(transaction, KAI));
  const call = kind.ProgrammableTransaction!.commands.flatMap((command) => (command.MoveCall ? [command.MoveCall] : []))
    .find((one) => normalizeSuiAddress(one.package) === PACKAGE)!;
  assert.equal(call.function, "commit_allowlisted");
  assert.deepEqual(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: SALE, sender: KAI, facts: FACTS }), { allowed: true });
});

test("the chain reads: another package's object is not this deployment's sale, a balance is the wallet's coins, and a node outage rejects", async () => {
  const { chain, core } = fixture();
  assert.equal(await chain.presale(`0x${"7".repeat(64)}`), null);
  // A `blast_presale::Presale` of another package is not a sale of this deployment.
  core.presales.set(NOVA, { saleToken: TOKEN, quote: USDC, initialSharedVersion: "1", packageId: `0x${"7".repeat(64)}` });
  assert.equal(await chain.presale(NOVA), null);
  assert.equal(await chain.balance(KAI, USDC), 70_000_000n);
  assert.equal(await chain.balance(NOVA, USDC), 0n);
  core.state.down = true;
  await assert.rejects(chain.presale(SALE));
  await assert.rejects(chain.balance(KAI, USDC));
});

/*
 * R3-41: a SUI-quoted sale, committed with Blast's gas pool paying the fee
 * (every commit is sponsored). The SDK's `commit` takes SUI with
 * `tx.coin`, whose SUI is the gas coin by default; sponsored, the gas coin is
 * Blast's, and the presale sponsor's policy refuses any kind that uses it.
 */
const SUI_SALE = `0x${"5a1f".padStart(64, "0")}`;
const SUI_FACTS = { ...FACTS, quote: SUI_COIN_TYPE };
const SUI = (whole: number) => BigInt(whole) * 1_000_000_000n;

function suiFixture() {
  const core = stubCommitCore(identity);
  core.presales.set(SUI_SALE, { saleToken: TOKEN, quote: SUI_COIN_TYPE, initialSharedVersion: "5150" });
  return { core, chain: createCommitChain({ client: core.client, identity }) };
}

const gasUsed = (program: NonNullable<ReturnType<typeof bcs.TransactionKind.parse>["ProgrammableTransaction"]>) =>
  program.commands.some((command) => JSON.stringify(command).includes("GasCoin"));

test("R3-41 (the sponsor bug): the SDK's own SUI commit splits the gas coin, and the sponsor's commit policy refuses it", async () => {
  const { core, chain } = suiFixture();
  holdCoins(core, KAI, SUI_COIN_TYPE, [stubCoin(3, SUI(30)), stubCoin(4, SUI(10))]);
  const presale = (await chain.presale(SUI_SALE))!;
  // Exactly what the route built before R3-41: `PresaleTransactions.commit`, its quote from `tx.coin` (useGasCoin true).
  const sdk = new PresaleTransactions(identity.presale);
  const before = sdk.commit({
    saleTokenType: TOKEN, quoteType: SUI_COIN_TYPE, route: "open", amount: SUI(25), recipient: KAI,
    presale: { objectId: presale.objectId, initialSharedVersion: presale.initialSharedVersion },
  });
  const kind = bcs.TransactionKind.parse(await chain.kind(before, KAI));
  assert.ok(gasUsed(kind.ProgrammableTransaction!), "the commitment is split from the gas coin");
  const decision = evaluateSponsorPolicy({ kind, intent: "commit", presaleId: SUI_SALE, sender: KAI, facts: SUI_FACTS });
  assert.equal(decision.allowed, false);
  assert.match(decision.allowed ? "" : decision.reason, /uses the gas coin/);
});

test("R3-41: a sponsored SUI commit takes Kai's own SUI coins (merged, split), never the gas coin, and the sponsor's policy takes it", async () => {
  const { core, chain } = suiFixture();
  holdCoins(core, KAI, SUI_COIN_TYPE, [stubCoin(3, SUI(30)), stubCoin(4, SUI(10))]);
  const presale = (await chain.presale(SUI_SALE))!;
  const transaction = commitTransaction({ identity, presale, saleToken: presale.saleToken, quoteType: presale.quote, atoms: SUI(25), recipient: KAI });
  const kind = bcs.TransactionKind.parse(await chain.kind(transaction, KAI));
  const program = kind.ProgrammableTransaction!;
  assert.equal(gasUsed(program), false, "a sponsored kind never touches the gas coin");
  const owned = program.inputs.flatMap((input) => (input.Object?.ImmOrOwnedObject ? [normalizeSuiAddress(input.Object.ImmOrOwnedObject.objectId)] : []));
  assert.deepEqual(owned.sort(), [stubCoin(3, 0n).objectId, stubCoin(4, 0n).objectId].sort(), "Kai's own two SUI coins");
  assert.deepEqual(program.commands.map((command) => command.$kind), ["MergeCoins", "SplitCoins", "MoveCall", "TransferObjects"]);
  const calls = program.commands.flatMap((command) => (command.MoveCall ? [command.MoveCall] : []));
  assert.deepEqual(calls.map((call) => [call.module, call.function, call.typeArguments.map((type) => normalizeStructTag(type))]), [["blast_presale", "commit_open", [TOKEN, SUI_COIN_TYPE]]]);
  // The split is exactly the commitment: 25 SUI in atoms.
  const split = program.commands.find((command) => command.SplitCoins)!.SplitCoins!;
  const amount = program.inputs[(split.amounts[0] as { Input: number }).Input]!.Pure!.bytes;
  assert.equal(bcs.u64().parse(Uint8Array.from(Buffer.from(amount, "base64"))), String(SUI(25)));
  assert.deepEqual(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: SUI_SALE, sender: KAI, facts: SUI_FACTS }), { allowed: true });
  assert.equal(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: SUI_SALE, sender: NOVA, facts: SUI_FACTS }).allowed, false);
});

test("R3-41: a sponsored SUI commit from an address balance redeems the sender's own funds, and an allowlisted one proves its leaf; the policy takes both", async () => {
  const { core, chain } = suiFixture();
  holdAddressBalance(core, KAI, SUI_COIN_TYPE, SUI(100));
  const presale = (await chain.presale(SUI_SALE))!;
  const fromBalance = bcs.TransactionKind.parse(await chain.kind(
    commitTransaction({ identity, presale, saleToken: presale.saleToken, quoteType: presale.quote, atoms: SUI(25), recipient: KAI }),
    KAI,
  ));
  const program = fromBalance.ProgrammableTransaction!;
  assert.equal(gasUsed(program), false);
  assert.ok(program.inputs.some((input) => input.FundsWithdrawal?.withdrawFrom.$kind === "Sender"), "withdrawn from the sender, never the sponsor");
  assert.deepEqual(evaluateSponsorPolicy({ kind: fromBalance, intent: "commit", presaleId: SUI_SALE, sender: KAI, facts: SUI_FACTS }), { allowed: true });

  holdCoins(core, KAI, SUI_COIN_TYPE, [stubCoin(5, SUI(40))]);
  const leaf = { index: 7n, wallet: KAI, walletCap: SUI(5_000), proof: ["01".repeat(32), "02".repeat(32)] };
  const allowlisted = bcs.TransactionKind.parse(await chain.kind(
    commitTransaction({ identity, presale, saleToken: presale.saleToken, quoteType: presale.quote, atoms: SUI(25), recipient: KAI, allowlist: leaf }),
    KAI,
  ));
  assert.equal(gasUsed(allowlisted.ProgrammableTransaction!), false);
  const call = allowlisted.ProgrammableTransaction!.commands.flatMap((command) => (command.MoveCall ? [command.MoveCall] : []))
    .find((one) => normalizeSuiAddress(one.package) === PACKAGE)!;
  assert.equal(call.function, "commit_allowlisted");
  assert.deepEqual(evaluateSponsorPolicy({ kind: allowlisted, intent: "commit", presaleId: SUI_SALE, sender: KAI, facts: SUI_FACTS }), { allowed: true });
});

test("a sponsored public contribution uses commit_uncapped without a proof and sends change to the buyer", async () => {
  const { chain } = fixture();
  const presale = (await chain.presale(SALE))!;
  const transaction = commitTransaction({ identity, presale, saleToken: TOKEN, quoteType: USDC, atoms: 1_000_000n, recipient: KAI, uncapped: true });
  const kind = bcs.TransactionKind.parse(await chain.kind(transaction, KAI));
  const calls = kind.ProgrammableTransaction!.commands.flatMap((c) => c.MoveCall ? [c.MoveCall.function] : []);
  assert.deepEqual(calls, ["commit_uncapped"]);
  assert.deepEqual(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: SALE, sender: KAI, facts: FACTS }), { allowed: true });
});
