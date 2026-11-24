import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { coinWithBalance, Transaction } from "@mysten/sui/transactions";

import {
  CETUS_ADAPTER_PACKAGE,
  CETUS_FIXTURE_PROVIDERS,
  CETUS_AGGREGATOR_PACKAGE,
  CETUS_SWAP_TARGETS,
  COIN_SOURCES,
  COMMIT_ROUTES,
  OTHER_PRESALE_ID,
  OTHER_SALE_ROUND_ID,
  OTHER_VAULT_ID,
  OTHER_WALLET,
  PRESALE_ID,
  PRESALE_PACKAGE,
  VAULT_PACKAGE,
  QUOTE,
  ROUND_ID,
  SALE_TOKEN,
  SENDER,
  SUI,
  VAULT_ID,
  cetusSponsoredSwap,
  cetusSwapAndCommit,
  kindOf,
  presale,
  rewardProof,
  sdkCancel,
  sdkClaim,
  sdkCommit,
  sdkRewardClaim,
  sdkSettle,
  cetusSwapBesideCommit,
} from "../../../test/fixtures/modules/sponsor/fixtures.ts";
import { linearVestingClaim } from "./linear-vesting.ts";
import { VESTING_PACKAGE } from "@blast/core/modules/vesting/model.ts";
import {
  evaluateSponsorPolicy,
  evaluateWithdrawPolicy,
  parseSwapTargets,
  referencedRewardRounds,
  referencedVestingSchedules,
  type SponsorPolicyFacts,
  type SponsorPolicyRequest,
} from "./policy.ts";
import { SPONSOR_SWAP_CALLS } from "./swap-calls.ts";

/**
 * T-015: the sponsor's spending boundary. Kinds come from the SDK builders,
 * the Cetus aggregator SDK in sponsored mode, or hostile edits of them.
 */

const FACTS: SponsorPolicyFacts = {
  presalePackageId: PRESALE_PACKAGE,
  vaultPackageId: VAULT_PACKAGE,
  saleToken: SALE_TOKEN,
  quote: QUOTE,
  rewardRounds: [],
  swapTargets: [],
};

const WITH_SWAPS: SponsorPolicyFacts = { ...FACTS, swapTargets: parseSwapTargets(CETUS_SWAP_TARGETS) };

const INTENTS = ["commit", "claim", "settle", "cancel", "reward_claim"] as const;

function request(kind: SponsorPolicyRequest["kind"], overrides: Partial<SponsorPolicyRequest> = {}): SponsorPolicyRequest {
  return { kind, intent: "commit", presaleId: PRESALE_ID, sender: SENDER, facts: FACTS, ...overrides };
}

function assertRefused(decision: ReturnType<typeof evaluateSponsorPolicy>, pattern: RegExp, label = ""): void {
  assert.equal(decision.allowed, false, `${label} was allowed`);
  if (decision.allowed) return;
  assert.equal(decision.code, "target_not_allowed", label);
  assert.match(decision.reason, pattern, label);
}

test("an SDK-built commit on every route is allowed", async () => {
  for (const route of COMMIT_ROUTES) {
    const decision = evaluateSponsorPolicy(request(await kindOf(sdkCommit(route))));
    assert.deepEqual(decision, { allowed: true }, route);
  }
});

test("each intent allows only its own presale calls", async () => {
  const kinds = {
    commit: await kindOf(sdkCommit("open")),
    claim: await kindOf(sdkClaim()),
    settle: await kindOf(sdkSettle()),
    cancel: await kindOf(sdkCancel()),
  };
  for (const [built, kind] of Object.entries(kinds)) {
    for (const intent of INTENTS) {
      const decision = evaluateSponsorPolicy(request(kind, { intent }));
      if (built === intent) assert.deepEqual(decision, { allowed: true }, `${built} under ${intent}`);
      else assertRefused(decision, /not allowed for intent/, `${built} under ${intent}`);
    }
  }
});

test("a presale call outside every intent's list, such as destroy_cap, is refused", async () => {
  const kind = await kindOf(
    presale.destroyCap({
      saleTokenType: SALE_TOKEN,
      quoteType: QUOTE,
      presale: { objectId: PRESALE_ID, initialSharedVersion: 7 },
      presaleCap: `0x${"77".repeat(32)}`,
    }),
  );
  for (const intent of INTENTS) {
    assertRefused(evaluateSponsorPolicy(request(kind, { intent })), /blast_presale::destroy_cap is not allowed/, intent);
  }
});

test("a call to a package that is neither the presale package nor a swap target is refused", async () => {
  const tx = sdkCommit("open");
  tx.moveCall({ target: `0x${"99".repeat(32)}::drain::all`, arguments: [] });
  assertRefused(evaluateSponsorPolicy(request(await kindOf(tx))), /drain::all is not allowed for intent commit/);
});

test("a kind with no call of its intent is refused", async () => {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.object(`0x${"d0".repeat(32)}`), [1n]);
  tx.transferObjects([coin], SENDER);
  for (const intent of INTENTS) {
    assertRefused(evaluateSponsorPolicy(request(await kindOf(tx), { intent })), /no .* call/, intent);
  }
});

test("a kind that is not a programmable transaction is refused", async () => {
  const { ProgrammableTransaction } = await kindOf(sdkCommit("open"));
  const bytes = bcs.TransactionKind.serialize({ ProgrammableSystemTransaction: ProgrammableTransaction! }).toBytes();
  assertRefused(evaluateSponsorPolicy(request(bcs.TransactionKind.parse(bytes))), /not a programmable transaction/);
});

test("a Publish or Upgrade command is refused for every intent", async () => {
  const modules = [[0xa1, 0x1c, 0xeb, 0x0b]];
  const publish = sdkCommit("open");
  const [cap] = publish.publish({ modules, dependencies: ["0x1", "0x2"] });
  publish.transferObjects([cap], SENDER);
  const upgrade = sdkCommit("open");
  upgrade.upgrade({ modules, dependencies: ["0x1", "0x2"], package: `0x${"88".repeat(32)}`, ticket: `0x${"89".repeat(32)}` });
  for (const [label, tx] of [["Publish", publish], ["Upgrade", upgrade]] as const) {
    const kind = await kindOf(tx);
    for (const intent of INTENTS) {
      assertRefused(evaluateSponsorPolicy(request(kind, { intent })), new RegExp(`${label} is not allowed`), `${label} ${intent}`);
    }
  }
});

test("a gas-coin argument anywhere is refused", async () => {
  const split = sdkCommit("open");
  const [fromGas] = split.splitCoins(split.gas, [1n]);
  split.transferObjects([fromGas], SENDER);
  const merge = sdkCommit("open");
  merge.mergeCoins(merge.gas, [merge.object(`0x${"d7".repeat(32)}`)]);
  const transfer = sdkCommit("open");
  transfer.transferObjects([transfer.gas], SENDER);
  const vector = sdkCommit("open");
  vector.makeMoveVec({ elements: [vector.gas] });
  const quote = new Transaction();
  quote.transferObjects([quote.add(presale.call.commitOpen({ saleTokenType: SALE_TOKEN, quoteType: QUOTE, presale: { objectId: PRESALE_ID, initialSharedVersion: 7 }, quoteIn: quote.gas }))], SENDER);
  for (const [label, tx] of Object.entries({ split, merge, transfer, vector, quote })) {
    assertRefused(evaluateSponsorPolicy(request(await kindOf(tx))), /gas coin/, label);
  }
});

test("a TransferObjects to anyone but the sender is refused", async () => {
  assertRefused(evaluateSponsorPolicy(request(await kindOf(sdkCommit("open", { recipient: OTHER_WALLET })))), /TransferObjects to .* not the sender/);
  const computed = sdkCommit("open");
  const [coin] = computed.splitCoins(computed.object(`0x${"d0".repeat(32)}`), [1n]);
  computed.transferObjects([coin], computed.moveCall({ target: "0x2::tx_context::sender" }));
  assertRefused(evaluateSponsorPolicy(request(await kindOf(computed))), /not allowed|not the sender/);
});

test("SDK commits allowed for every coin source; a withdrawal from the sponsor's address balance is refused", async () => {
  for (const source of COIN_SOURCES) {
    assert.deepEqual(evaluateSponsorPolicy(request(await kindOf(sdkCommit("open"), { source }))), { allowed: true }, source);
  }
  const kind = await kindOf(sdkCommit("open"), { source: "address balance" });
  const inputs = kind.ProgrammableTransaction!.inputs;
  const withdrawal = inputs.findIndex((input) => input.$kind === "FundsWithdrawal");
  assert.ok(withdrawal >= 0, "the address-balance commit withdraws funds");
  const fromSponsor = structuredClone(kind);
  fromSponsor.ProgrammableTransaction!.inputs[withdrawal].FundsWithdrawal!.withdrawFrom = { $kind: "Sponsor", Sponsor: true };
  assertRefused(evaluateSponsorPolicy(request(fromSponsor)), /withdraws from Sponsor/);
});

test("a framework call that pays another address is refused; one outside the derived list is refused", async () => {
  const sendFunds = (recipient: string) => {
    const tx = sdkCommit("open");
    const [coin] = tx.splitCoins(tx.object(`0x${"d0".repeat(32)}`), [1n]);
    tx.moveCall({ target: "0x2::coin::send_funds", typeArguments: [QUOTE], arguments: [coin, tx.pure.address(recipient)] });
    return tx;
  };
  assert.deepEqual(evaluateSponsorPolicy(request(await kindOf(sendFunds(SENDER)))), { allowed: true });
  assertRefused(evaluateSponsorPolicy(request(await kindOf(sendFunds(OTHER_WALLET)))), /coin::send_funds argument 1 is not the sender/);

  for (const recipient of [OTHER_WALLET, SENDER]) {
    const tx = sdkCommit("open");
    const [coin] = tx.splitCoins(tx.object(`0x${"d0".repeat(32)}`), [1n]);
    tx.moveCall({ target: "0x2::transfer::public_transfer", typeArguments: [`0x2::coin::Coin<${QUOTE}>`], arguments: [coin, tx.pure.address(recipient)] });
    assertRefused(evaluateSponsorPolicy(request(await kindOf(tx))), /transfer::public_transfer is not allowed/, recipient);
  }
});

test("framework calls are sponsored only for commit", async () => {
  const tx = sdkClaim();
  tx.moveCall({ target: "0x2::coin::zero", typeArguments: [QUOTE] });
  assertRefused(evaluateSponsorPolicy(request(await kindOf(tx), { intent: "claim" })), /coin::zero is not allowed for intent claim/);
});

test("Cetus sponsored-mode swap-and-commit is allowed through the configured swap targets", async () => {
  for (const provider of ["CETUS", "DEEPBOOKV3"]) {
    for (const source of COIN_SOURCES) {
      const kind = await kindOf(await cetusSwapAndCommit(provider), { source, amount: 1_000_000_000n });
      assert.deepEqual(evaluateSponsorPolicy(request(kind, { facts: WITH_SWAPS })), { allowed: true }, `${provider} ${source}`);
    }
  }
});

test("a Cetus swap is refused when its module is not configured, under another intent, or without a commit", async () => {
  const kind = await kindOf(await cetusSwapAndCommit("CETUS"), { amount: 1_000_000_000n });
  assertRefused(evaluateSponsorPolicy(request(kind)), /router::new_swap_context_v3 is not allowed for intent commit/, "no targets");
  const routerOnly = { ...FACTS, swapTargets: parseSwapTargets(`${CETUS_AGGREGATOR_PACKAGE}::router`) };
  assertRefused(evaluateSponsorPolicy(request(kind, { facts: routerOnly })), /cetus::swap is not allowed/, "adapter not configured");
  const otherPackage = { ...FACTS, swapTargets: parseSwapTargets(`${CETUS_AGGREGATOR_PACKAGE}::router,${OTHER_WALLET}::cetus`) };
  assertRefused(evaluateSponsorPolicy(request(kind, { facts: otherPackage })), /cetus::swap is not allowed/, "module in another package");

  const claimWithSwap = await kindOf(await cetusSwapAndCommit("CETUS"), { amount: 1_000_000_000n });
  assertRefused(evaluateSponsorPolicy(request(claimWithSwap, { intent: "claim", facts: WITH_SWAPS })), /not allowed for intent claim/);

  const swapOnly = await kindOf(await cetusSponsoredSwap("CETUS"), { amount: 1_000_000_000n });
  const withUtils = { ...FACTS, swapTargets: parseSwapTargets(`${CETUS_SWAP_TARGETS},${CETUS_AGGREGATOR_PACKAGE}::utils`) };
  assertRefused(evaluateSponsorPolicy(request(swapOnly, { facts: withUtils })), /no .*commit_open.* call/);
});

test("swap targets parse from PRESALE_SPONSOR_SWAP_TARGETS and reject framework or malformed entries", () => {
  assert.deepEqual(parseSwapTargets(undefined), []);
  assert.deepEqual(parseSwapTargets("  "), []);
  assert.deepEqual(parseSwapTargets(` 0xc0::router , ${CETUS_ADAPTER_PACKAGE}::cetus,0xC0::router `), [
    { packageId: `0x${"0".repeat(62)}c0`, module: "router" },
    { packageId: CETUS_ADAPTER_PACKAGE, module: "cetus" },
  ]);
  for (const bad of ["0x2::coin", "0x1::option", "0x0000000000000000000000000000000000000000000000000000000000000002::pay", "router", "0xc0::", "0xc0::router::swap", "0xzz::router", "0xc0::9router", "0xc0::*"]) {
    assert.throws(() => parseSwapTargets(bad), /PRESALE_SPONSOR_SWAP_TARGETS/, bad);
  }
});

test("a presale call on another presale is refused", async () => {
  const kinds = {
    commit: await kindOf(sdkCommit("open", { presaleId: OTHER_PRESALE_ID })),
    claim: await kindOf(sdkClaim([SENDER], OTHER_PRESALE_ID)),
    settle: await kindOf(sdkSettle(OTHER_PRESALE_ID)),
    cancel: await kindOf(sdkCancel(OTHER_PRESALE_ID)),
  };
  for (const [intent, kind] of Object.entries(kinds)) {
    assertRefused(evaluateSponsorPolicy(request(kind, { intent: intent as keyof typeof kinds })), /is not presale/, intent);
  }
});

test("wrong type arguments on a presale call are refused", async () => {
  const swapped = { saleTokenType: QUOTE, quoteType: SALE_TOKEN };
  const otherQuote = { saleTokenType: SALE_TOKEN, quoteType: `0x${"5b".repeat(32)}::other::OTHER` };
  for (const [label, types] of Object.entries({ swapped, otherQuote })) {
    assertRefused(evaluateSponsorPolicy(request(await kindOf(sdkCommit("open", { types })))), /type arguments/, label);
  }
  const reward = await kindOf(sdkRewardClaim());
  const untyped = structuredClone(reward);
  const call = untyped.ProgrammableTransaction!.commands[0].MoveCall!;
  call.typeArguments = [SALE_TOKEN];
  const facts = { ...FACTS, rewardRounds: [{ roundId: ROUND_ID, vaultId: VAULT_ID, vaultPresaleId: PRESALE_ID }] };
  assertRefused(evaluateSponsorPolicy(request(untyped, { intent: "reward_claim", facts })), /type arguments/);
});

test("a claim whose participant is not the sender is refused; the sender's own claim is allowed", async () => {
  assert.deepEqual(evaluateSponsorPolicy(request(await kindOf(sdkClaim([SENDER])), { intent: "claim" })), { allowed: true });
  assertRefused(evaluateSponsorPolicy(request(await kindOf(sdkClaim([OTHER_WALLET])), { intent: "claim" })), /participant .* is not the sender/);
  assertRefused(evaluateSponsorPolicy(request(await kindOf(sdkClaim([SENDER, OTHER_WALLET])), { intent: "claim" })), /participant .* is not the sender/, "relay");
});

test("reward_claim is allowed only on a round of this sale's vault and only for the sender", async () => {
  const facts: SponsorPolicyFacts = {
    ...FACTS,
    rewardRounds: [
      { roundId: ROUND_ID, vaultId: VAULT_ID, vaultPresaleId: PRESALE_ID },
      { roundId: OTHER_SALE_ROUND_ID, vaultId: OTHER_VAULT_ID, vaultPresaleId: OTHER_PRESALE_ID },
    ],
  };
  const claim = (kind: SponsorPolicyRequest["kind"]) => evaluateSponsorPolicy(request(kind, { intent: "reward_claim", facts }));
  assert.deepEqual(claim(await kindOf(sdkRewardClaim())), { allowed: true });
  assertRefused(claim(await kindOf(sdkRewardClaim({ round: OTHER_SALE_ROUND_ID }))), /round .* belongs to presale/);
  assertRefused(claim(await kindOf(sdkRewardClaim({ round: `0x${"57".repeat(32)}` }))), /round .* is unknown/);
  assertRefused(claim(await kindOf(sdkRewardClaim({ allocations: [rewardProof(OTHER_WALLET)] }))), /beneficiary .* is not the sender/);
  assertRefused(
    claim(await kindOf(sdkRewardClaim({ allocations: [rewardProof(), rewardProof(OTHER_WALLET)] }))),
    /beneficiary .* is not the sender/,
    "batch with another beneficiary",
  );
});

test("an SDK commit of a SUI-quoted sale takes its Quote from the gas coin and is refused", async () => {
  const facts = { ...FACTS, quote: SUI };
  const kind = await kindOf(sdkCommit("open", { types: { saleTokenType: SALE_TOKEN, quoteType: SUI } }));
  assertRefused(evaluateSponsorPolicy(request(kind, { facts })), /uses the gas coin/);
});

test("R3-41: a SUI-quoted commit whose SUI comes from the sender's own coins (the web's sponsored build) is allowed for every coin source", async () => {
  // The web's `commit/chain.ts` composes a sponsored SUI commit from the SDK's own calls with
  // `tx.coin({ type: SUI, useGasCoin: false })`: the sender's SUI, never the sponsor's gas coin.
  const facts = { ...FACTS, quote: SUI };
  for (const route of ["open", "allowlisted"] as const) {
    for (const source of COIN_SOURCES) {
      const tx = new Transaction();
      const quote = tx.coin({ type: SUI, balance: 1_000_000n, useGasCoin: false });
      const options = { saleTokenType: SALE_TOKEN, quoteType: SUI, presale: { objectId: PRESALE_ID, initialSharedVersion: 7 }, quoteIn: quote };
      const change = tx.add(route === "allowlisted"
        ? presale.call.commitAllowlisted({ ...options, allowlist: { index: 3n, wallet: SENDER, walletCap: 5_000_000n, proof: ["ab".repeat(32), "cd".repeat(32)] } })
        : presale.call.commitOpen(options));
      tx.transferObjects([change], SENDER);
      const kind = await kindOf(tx, { source });
      assert.ok(!JSON.stringify(kind).includes("GasCoin"), `${route}, ${source}: no gas coin`);
      assert.deepEqual(evaluateSponsorPolicy(request(kind, { facts })), { allowed: true }, `${route}, ${source}`);
    }
  }
});

test("a swap-target entry never widens the presale package, and an unknown intent is refused", async () => {
  const kind = await kindOf(
    presale.destroyCap({
      saleTokenType: SALE_TOKEN,
      quoteType: QUOTE,
      presale: { objectId: PRESALE_ID, initialSharedVersion: 7 },
      presaleCap: `0x${"77".repeat(32)}`,
    }),
  );
  const tx = sdkCommit("open");
  tx.add(presale.call.settle({ saleTokenType: SALE_TOKEN, quoteType: QUOTE, presale: { objectId: PRESALE_ID, initialSharedVersion: 7 } }));
  const facts = { ...FACTS, swapTargets: parseSwapTargets(`${PRESALE_PACKAGE}::blast_presale`) };
  assertRefused(evaluateSponsorPolicy(request(kind, { facts })), /presale package .* is not a swap target/);
  assertRefused(evaluateSponsorPolicy(request(await kindOf(tx), { facts })), /presale package .* is not a swap target/);
  assertRefused(evaluateSponsorPolicy(request(await kindOf(tx))), /blast_presale::settle is not allowed for intent commit/);
  const unknown = { intent: "withdraw" } as unknown as Partial<SponsorPolicyRequest>;
  assertRefused(evaluateSponsorPolicy(request(await kindOf(sdkCommit("open")), unknown)), /unknown intent withdraw/);
});

/** P-13: a vesting schedule paying the sender in the sale's token, as the sponsor's chain read resolves it. */
const SCHEDULE = { objectId: `0x${"70".repeat(32)}`, coinType: SALE_TOKEN, beneficiary: SENDER };
const vestingClaim = (schedule: { objectId: string; coinType: string } = SCHEDULE) =>
  kindOf(linearVestingClaim({ ...schedule, initialSharedVersion: "12" }));

test("P-13: the sender's own vesting claim is allowed under claim, in either of the sale's coins", async () => {
  const facts = { ...FACTS, vestingSchedules: [SCHEDULE] };
  assert.deepEqual(evaluateSponsorPolicy(request(await vestingClaim(), { intent: "claim", facts })), { allowed: true });
  const raise = { ...SCHEDULE, coinType: QUOTE };
  assert.deepEqual(evaluateSponsorPolicy(request(await vestingClaim(raise), { intent: "claim", facts: { ...FACTS, vestingSchedules: [raise] } })), { allowed: true });
});

test("P-13: a vesting claim is refused unless every pin holds", async () => {
  const facts = { ...FACTS, vestingSchedules: [SCHEDULE] };
  const claim = (kind: SponsorPolicyRequest["kind"], overrides: Partial<SponsorPolicyRequest> = {}) =>
    evaluateSponsorPolicy(request(kind, { intent: "claim", facts, ...overrides }));
  const kind = await vestingClaim();
  // Only the claim intent sponsors it.
  for (const intent of ["commit", "settle", "cancel", "reward_claim"] as const) {
    assertRefused(claim(kind, { intent }), /is not allowed for intent/, intent);
  }
  // A schedule the chain read did not resolve, or one paying someone else.
  assertRefused(claim(kind, { facts: FACTS }), /vesting schedule .* is unknown/);
  assertRefused(claim(kind, { facts: { ...FACTS, vestingSchedules: [{ ...SCHEDULE, beneficiary: OTHER_WALLET }] } }), /does not pay the sender/);
  // A type argument other than the schedule's coin, or a coin that is not the sale's.
  assertRefused(claim(await vestingClaim({ ...SCHEDULE, coinType: QUOTE })), /is not the schedule's/);
  const foreign = { ...SCHEDULE, coinType: SUI };
  assertRefused(claim(await vestingClaim(foreign), { facts: { ...FACTS, vestingSchedules: [foreign] } }), /not one of the sale's coins/);
  // Another function of the vesting package, another clock, or another shape.
  const close = structuredClone(kind);
  close.ProgrammableTransaction!.commands[0].MoveCall!.function = "close_irrevocable";
  assertRefused(claim(close), /blast_fun_linear_vesting::close_irrevocable is not allowed for intent claim/);
  const tx = new Transaction();
  tx.moveCall({
    target: `${VESTING_PACKAGE}::blast_fun_linear_vesting::claim`,
    typeArguments: [SALE_TOKEN],
    arguments: [tx.sharedObjectRef({ objectId: SCHEDULE.objectId, initialSharedVersion: 12, mutable: true }), tx.sharedObjectRef({ objectId: `0x${"71".repeat(32)}`, initialSharedVersion: 1, mutable: false })],
  });
  assertRefused(claim(await kindOf(tx)), /argument 1 is not the derived object/);
  const extra = structuredClone(kind);
  extra.ProgrammableTransaction!.commands[0].MoveCall!.arguments.push({ $kind: "GasCoin", GasCoin: true });
  assertRefused(claim(extra), /uses the gas coin/);
  const untyped = structuredClone(kind);
  untyped.ProgrammableTransaction!.commands[0].MoveCall!.typeArguments = [];
  assertRefused(claim(untyped), /takes 0 type arguments/);
  // The same call on a look-alike package is no vesting claim at all.
  const lookalike = structuredClone(kind);
  lookalike.ProgrammableTransaction!.commands[0].MoveCall!.package = `0x${"72".repeat(32)}`;
  assertRefused(claim(lookalike), /is not allowed for intent claim/);
});

test("P-13: referencedVestingSchedules lists the schedules a kind's vesting claims name, for the caller to resolve", async () => {
  assert.deepEqual(referencedVestingSchedules(await vestingClaim()), [SCHEDULE.objectId]);
  assert.deepEqual(referencedVestingSchedules(await kindOf(sdkClaim())), []);
});

test("referencedRewardRounds lists the rounds a kind's holder_rewards::claim calls name, for the caller to resolve", async () => {
  const kind = await kindOf(sdkRewardClaim({ allocations: [rewardProof(), rewardProof()] }));
  assert.deepEqual(referencedRewardRounds(kind, VAULT_PACKAGE), [ROUND_ID]);
  assert.deepEqual(referencedRewardRounds(await kindOf(sdkCommit("open")), VAULT_PACKAGE), []);
});

/** Points `kind`'s command `index` argument `position` at a new pure input holding `bytes`. */
function setPure(kind: SponsorPolicyRequest["kind"], index: number, position: number, bytes: Uint8Array): void {
  const { inputs, commands } = kind.ProgrammableTransaction!;
  inputs.push({ $kind: "Pure", Pure: { bytes: Buffer.from(bytes).toString("base64") } });
  commands[index].MoveCall!.arguments[position] = { $kind: "Input", Input: inputs.length - 1 };
}

const addressBytes = (address: string) => Buffer.from(address.slice(2).padStart(64, "0"), "hex");
const u32Bytes = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};

test("A28: a configured router module cannot pay the swap balance to a third party", async () => {
  const tx = new Transaction();
  const coin = tx.coin({ type: QUOTE, balance: 2_000_000n, useGasCoin: false });
  const [toCommit] = tx.splitCoins(coin, [1n]);
  const router = `${CETUS_AGGREGATOR_PACKAGE}::router`;
  const context = tx.moveCall({
    target: `${router}::new_swap_context_v3`,
    typeArguments: [QUOTE, SUI],
    arguments: [tx.pure.string("q"), tx.pure.u64(1n), tx.pure.u64(1n), tx.pure.u64(0n), tx.pure.u64(0n), coin, tx.pure.u32(0), tx.pure.address("0x0")],
  });
  const balance = tx.moveCall({ target: `${router}::take_balance`, typeArguments: [QUOTE], arguments: [context, tx.pure.u64(1_999_999n)] });
  tx.moveCall({ target: `${router}::transfer_balance`, typeArguments: [QUOTE], arguments: [balance, tx.pure.address(OTHER_WALLET)] });
  const out = tx.moveCall({ target: `${router}::confirm_swap_v3`, typeArguments: [SUI], arguments: [context] });
  tx.moveCall({ target: `${router}::transfer_or_destroy_coin`, typeArguments: [SUI], arguments: [out] });
  const change = tx.add(presale.call.commitOpen({ saleTokenType: SALE_TOKEN, quoteType: QUOTE, presale: { objectId: PRESALE_ID, initialSharedVersion: 7 }, quoteIn: toCommit }));
  tx.transferObjects([change], SENDER);
  assertRefused(evaluateSponsorPolicy(request(await kindOf(tx, { amount: 2_000_000n }), { facts: WITH_SWAPS })), /router::take_balance is not a derived swap function/);

  const direct = sdkCommit("open");
  const [split] = direct.splitCoins(direct.object(`0x${"d0".repeat(32)}`), [1n]);
  direct.moveCall({ target: `${router}::transfer_balance`, typeArguments: [QUOTE], arguments: [split, direct.pure.address(OTHER_WALLET)] });
  assertRefused(evaluateSponsorPolicy(request(await kindOf(direct), { facts: WITH_SWAPS })), /router::transfer_balance is not a derived swap function/);
});

test("A29: a swap fee is refused unless its rate is zero and its recipient is the pinned 0x0; the fixture's own swap stays allowed", async () => {
  const swap = async () => {
    const kind = await kindOf(await cetusSwapAndCommit("CETUS"), { amount: 1_000_000_000n });
    const index = kind.ProgrammableTransaction!.commands.findIndex((command) => command.MoveCall?.function === "new_swap_context_v3");
    return { kind, index };
  };
  const pinned = /new_swap_context_v3 argument 7 is not the derived address 0x0+$/;
  const cases: [string, string, number, RegExp][] = [
    ["10% to a third party", OTHER_WALLET, 100_000, pinned],
    ["1 ppm to a third party", OTHER_WALLET, 1, pinned],
    ["10% to the sender", SENDER, 100_000, pinned],
    ["no fee, recipient a third party", OTHER_WALLET, 0, pinned],
    ["10% to 0x0", "0x0", 100_000, /new_swap_context_v3 fee rate 100000 ppm is not zero/],
  ];
  for (const [label, recipient, rate, pattern] of cases) {
    const { kind, index } = await swap();
    setPure(kind, index, 7, addressBytes(recipient));
    setPure(kind, index, 6, u32Bytes(rate));
    assertRefused(evaluateSponsorPolicy(request(kind, { facts: WITH_SWAPS })), pattern, label);
  }
  const { kind } = await swap();
  assert.deepEqual(evaluateSponsorPolicy(request(kind, { facts: WITH_SWAPS })), { allowed: true });
});

test("a swap call must use its derived pinned and recipient arguments", async () => {
  const { kind } = { kind: await kindOf(await cetusSwapAndCommit("CETUS"), { amount: 1_000_000_000n }) };
  const index = kind.ProgrammableTransaction!.commands.findIndex((command) => command.MoveCall?.function === "swap");
  setPure(kind, index, 5, addressBytes(OTHER_WALLET));
  assertRefused(evaluateSponsorPolicy(request(kind, { facts: WITH_SWAPS })), /cetus::swap argument 5 holds an address that is not the sender/);
});

test("Q-002: the policy refuses framework packages in facts.swapTargets", async () => {
  const tx = sdkCommit("open");
  const [coin] = tx.splitCoins(tx.object(`0x${"d0".repeat(32)}`), [1n]);
  tx.moveCall({ target: "0x2::transfer::public_transfer", typeArguments: [`0x2::coin::Coin<${QUOTE}>`], arguments: [coin, tx.pure.address(OTHER_WALLET)] });
  for (const packageId of ["0x2", `0x${"0".repeat(63)}2`, "0x1"]) {
    const facts = { ...FACTS, swapTargets: [{ packageId, module: "transfer" }] };
    assertRefused(evaluateSponsorPolicy(request(await kindOf(tx), { facts })), /framework package .* is not a swap target|transfer::public_transfer is not allowed/, packageId);
  }
});

test("B-003: a sponsored swap must end in the sale's Quote", async () => {
  const other = `0x${"5c".repeat(32)}::other::OTHER`;
  const kind = await kindOf(await cetusSwapBesideCommit(other), { amount: 1_000_000_000n });
  assertRefused(evaluateSponsorPolicy(request(kind, { facts: WITH_SWAPS })), /swap ends in .* not the sale's Quote/);
  const quote = await kindOf(await cetusSwapBesideCommit(QUOTE), { amount: 1_000_000_000n });
  assert.deepEqual(evaluateSponsorPolicy(request(quote, { facts: WITH_SWAPS })), { allowed: true });
});

test("every derived Cetus provider's sponsored-mode swap-and-commit stays allowed at function level", async () => {
  const modules = [...new Set(SPONSOR_SWAP_CALLS.map(({ target }) => target.split("::")[0]))];
  const targets = modules.map((module) => `${module === "router" ? CETUS_AGGREGATOR_PACKAGE : CETUS_ADAPTER_PACKAGE}::${module}`);
  const facts = { ...FACTS, swapTargets: parseSwapTargets(targets.join(",")) };
  for (const provider of CETUS_FIXTURE_PROVIDERS) {
    const kind = await kindOf(await cetusSwapAndCommit(provider), { amount: 1_000_000_000n });
    assert.deepEqual(evaluateSponsorPolicy(request(kind, { facts })), { allowed: true }, provider);
  }
});

test("Q-003: a derived framework call refuses an address where its builds passed none", async () => {
  const tx = sdkCommit("open");
  tx.moveCall({ target: "0x2::coin::destroy_zero", typeArguments: [QUOTE], arguments: [tx.pure.address(OTHER_WALLET)] });
  assertRefused(evaluateSponsorPolicy(request(await kindOf(tx))), /coin::destroy_zero argument 0 is a pure value, not owned/);
});

/** Points `kind`'s command `index` argument `position` at a new shared-object input `objectId`. */
function setSharedObject(kind: SponsorPolicyRequest["kind"], index: number, position: number, objectId: string): void {
  const { inputs, commands } = kind.ProgrammableTransaction!;
  inputs.push({ $kind: "Object", Object: { $kind: "SharedObject", SharedObject: { objectId, initialSharedVersion: "3", mutable: true } } });
  commands[index].MoveCall!.arguments[position] = { $kind: "Input", Input: inputs.length - 1 };
}

async function swapKind(provider: string, fn: string) {
  const kind = await kindOf(await cetusSwapAndCommit(provider), { amount: 1_000_000_000n });
  const index = kind.ProgrammableTransaction!.commands.findIndex((command) => `${command.MoveCall?.module}::${command.MoveCall?.function}` === fn);
  assert.ok(index >= 0, `${provider} calls ${fn}`);
  return { kind, index };
}

function sharedObjectAt(kind: SponsorPolicyRequest["kind"], index: number, position: number): string | undefined {
  const argument = kind.ProgrammableTransaction!.commands[index].MoveCall!.arguments[position];
  return argument.$kind === "Input" ? kind.ProgrammableTransaction!.inputs[argument.Input].Object?.SharedObject?.objectId : undefined;
}

test("Q-008: a third party's Cetus Partner object substituted in a swap is refused", async () => {
  for (const [provider, fn] of [["CETUS", "cetus::swap"], ["CETUSDLMM", "cetus_dlmm::swap"]] as const) {
    const { kind, index } = await swapKind(provider, fn);
    const args = kind.ProgrammableTransaction!.commands[index].MoveCall!.arguments;
    const partner = args.findIndex((_, position) => /^0x(639b5e43|59ae16f6)/.test(sharedObjectAt(kind, index, position) ?? ""));
    assert.ok(partner >= 0, `${fn} takes the SDK's default Partner`);
    setSharedObject(kind, index, partner, `0x${"e8".repeat(32)}`);
    const facts = { ...FACTS, swapTargets: parseSwapTargets(`${CETUS_SWAP_TARGETS},${CETUS_ADAPTER_PACKAGE}::cetus_dlmm`) };
    assertRefused(evaluateSponsorPolicy(request(kind, { facts })), new RegExp(`${fn} argument ${partner} is not the derived object`), fn);
  }
});

test("a shared object where the fixtures pass none, or a Receiving object, is refused", async () => {
  const { kind, index } = await swapKind("CETUS", "router::confirm_swap_v3");
  setSharedObject(kind, index, 0, `0x${"e8".repeat(32)}`);
  assertRefused(evaluateSponsorPolicy(request(kind, { facts: WITH_SWAPS })), /confirm_swap_v3 argument 0 is a shared object, not result/);

  const receiving = await swapKind("CETUS", "cetus::swap");
  const { inputs, commands } = receiving.kind.ProgrammableTransaction!;
  inputs.push({ $kind: "Object", Object: { $kind: "Receiving", Receiving: { objectId: `0x${"e8".repeat(32)}`, version: "4", digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" } } });
  commands[receiving.index].MoveCall!.arguments[1] = { $kind: "Input", Input: inputs.length - 1 };
  assertRefused(evaluateSponsorPolicy(request(receiving.kind, { facts: WITH_SWAPS })), /cetus::swap argument 1 is a Receiving object, not shared/);
});

test("B-005 residual: the route's pool object is not pinned, so another pool passes", async () => {
  const { kind, index } = await swapKind("CETUS", "cetus::swap");
  const args = kind.ProgrammableTransaction!.commands[index].MoveCall!.arguments;
  const pool = args.findIndex((_, position) => sharedObjectAt(kind, index, position) === `0x${"b0".repeat(32)}`);
  assert.ok(pool >= 0, "cetus::swap takes the route's pool");
  setSharedObject(kind, index, pool, `0x${"b7".repeat(32)}`);
  assert.deepEqual(evaluateSponsorPolicy(request(kind, { facts: WITH_SWAPS })), { allowed: true });
});

test("B-006: a derived call with a different argument or type-argument count is refused", async () => {
  const truncated = await swapKind("CETUS", "router::new_swap_context_v3");
  truncated.kind.ProgrammableTransaction!.commands[truncated.index].MoveCall!.arguments.pop();
  assertRefused(evaluateSponsorPolicy(request(truncated.kind, { facts: WITH_SWAPS })), /new_swap_context_v3 takes 7 arguments, not the derived 8/);

  const appended = await swapKind("CETUS", "cetus::swap");
  setPure(appended.kind, appended.index, appended.kind.ProgrammableTransaction!.commands[appended.index].MoveCall!.arguments.length, Uint8Array.of(1, ...addressBytes(OTHER_WALLET)));
  assertRefused(evaluateSponsorPolicy(request(appended.kind, { facts: WITH_SWAPS })), /cetus::swap takes \d+ arguments, not the derived/);

  const typed = await swapKind("CETUS", "router::confirm_swap_v3");
  typed.kind.ProgrammableTransaction!.commands[typed.index].MoveCall!.typeArguments.push(SUI);
  assertRefused(evaluateSponsorPolicy(request(typed.kind, { facts: WITH_SWAPS })), /confirm_swap_v3 takes 2 type arguments, not the derived 1/);

  const zero = sdkCommit("open");
  zero.moveCall({ target: "0x2::coin::zero", typeArguments: [QUOTE, SUI] });
  assertRefused(evaluateSponsorPolicy(request(await kindOf(zero))), /coin::zero takes 2 type arguments, not the derived 1/);
});

/** Points `kind`'s command `index` argument `position` at a new owned-object input `objectId`. */
function setOwnedObject(kind: SponsorPolicyRequest["kind"], index: number, position: number, objectId: string): void {
  const { inputs, commands } = kind.ProgrammableTransaction!;
  inputs.push({ $kind: "Object", Object: { $kind: "ImmOrOwnedObject", ImmOrOwnedObject: { objectId, version: "4", digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" } } });
  commands[index].MoveCall!.arguments[position] = { $kind: "Input", Input: inputs.length - 1 };
}

test("Q-012/B-007: an owned object or a command result at a derived shared-object or value position is refused", async () => {
  const facts = { ...FACTS, swapTargets: parseSwapTargets(`${CETUS_SWAP_TARGETS},${CETUS_ADAPTER_PACKAGE}::cetus_dlmm`) };
  const cases: [string, string, string, number, (kind: SponsorPolicyRequest["kind"], index: number, position: number) => void, RegExp][] = [
    ["R01d third-party Partner as an owned object", "CETUS", "cetus::swap", 3, (kind, index, position) => setOwnedObject(kind, index, position, OTHER_WALLET), /cetus::swap argument 3 is an owned object, not shared/],
    ["R01d on cetus_dlmm", "CETUSDLMM", "cetus_dlmm::swap", 3, (kind, index, position) => setOwnedObject(kind, index, position, OTHER_WALLET), /cetus_dlmm::swap argument 3 is an owned object, not shared/],
    ["R05h owned object at GlobalConfig", "CETUS", "cetus::swap", 1, (kind, index, position) => setOwnedObject(kind, index, position, `0x${"e8".repeat(32)}`), /cetus::swap argument 1 is an owned object, not shared/],
    ["R02d owned object at the bool", "CETUS", "cetus::swap", 4, (kind, index, position) => setOwnedObject(kind, index, position, `0x${"e8".repeat(32)}`), /cetus::swap argument 4 is an owned object, not pure/],
    [
      "R01e command result at the Partner",
      "CETUS",
      "cetus::swap",
      3,
      (kind, index, position) => {
        kind.ProgrammableTransaction!.commands[index].MoveCall!.arguments[position] = { $kind: "NestedResult", NestedResult: [0, 0] };
      },
      /cetus::swap argument 3 is a result, not shared/,
    ],
  ];
  for (const [label, provider, fn, position, edit, pattern] of cases) {
    const { kind, index } = await swapKind(provider, fn);
    edit(kind, index, position);
    assertRefused(evaluateSponsorPolicy(request(kind, { facts })), pattern, label);
  }
});

test("a derived framework call refuses an input kind its builds never passed", async () => {
  const tx = sdkCommit("open");
  const [coin] = tx.splitCoins(tx.object(`0x${"d0".repeat(32)}`), [1n]);
  tx.moveCall({ target: "0x2::coin::send_funds", typeArguments: [QUOTE], arguments: [coin, tx.object(`0x${"e8".repeat(32)}`)] });
  assertRefused(evaluateSponsorPolicy(request(await kindOf(tx))), /coin::send_funds argument 1 is a shared object, not pure/);
});

/** An owned coin of the sender, by reference (the offline client resolves a bare `tx.object` id as shared). */
const ownedCoin = (tx: Transaction, byte = "d0") => tx.objectRef({ objectId: `0x${byte.repeat(32)}`, version: "11", digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" });

/** Social UI-14: `coinWithBalance` of `type` sent to `recipient`, as the coins sheet builds a withdrawal. */
function withdrawal(type: string, recipient = OTHER_WALLET, amount = 1_000_000n): Transaction {
  const tx = new Transaction();
  const coin = tx.add(coinWithBalance({ type, balance: amount, useGasCoin: false }));
  tx.transferObjects([coin], tx.pure.address(recipient));
  return tx;
}

test("withdraw: the sender's USDC, SUI or sale coin to any address is allowed for every coin source", async () => {
  for (const type of [QUOTE, SUI, SALE_TOKEN]) {
    for (const source of COIN_SOURCES) {
      const kind = await kindOf(withdrawal(type), { source });
      assert.deepEqual(evaluateWithdrawPolicy({ kind, sender: SENDER }), { allowed: true }, `${type} from ${source}`);
    }
  }
  // Sending to oneself is a transfer like any other.
  assert.deepEqual(evaluateWithdrawPolicy({ kind: await kindOf(withdrawal(QUOTE, SENDER)), sender: SENDER }), { allowed: true });
});

test("no presale call passes the withdraw policy", async () => {
  const commit = sdkCommit("open");
  const coin = commit.add(coinWithBalance({ type: QUOTE, balance: 5n, useGasCoin: false }));
  commit.transferObjects([coin], commit.pure.address(OTHER_WALLET));
  assertRefused(evaluateWithdrawPolicy({ kind: await kindOf(commit), sender: SENDER }), /blast_presale::commit_open is not allowed for intent withdraw/);
});

test("withdraw: no transfer, two transfers, or a transfer of anything but a split coin is refused", async () => {
  const none = new Transaction();
  none.add(coinWithBalance({ type: QUOTE, balance: 5n, useGasCoin: false }));
  assertRefused(evaluateWithdrawPolicy({ kind: await kindOf(none), sender: SENDER }), /exactly one TransferObjects, not 0/);

  const two = withdrawal(QUOTE);
  const [extra] = two.splitCoins(ownedCoin(two, "d5"), [1n]);
  two.transferObjects([extra], two.pure.address(OTHER_WALLET));
  assertRefused(evaluateWithdrawPolicy({ kind: await kindOf(two), sender: SENDER }), /exactly one TransferObjects, not 2/);

  // A whole owned object (say an NFT) is not a coin the sheet withdraws.
  const object = new Transaction();
  object.transferObjects([ownedCoin(object, "d7")], object.pure.address(OTHER_WALLET));
  assertRefused(evaluateWithdrawPolicy({ kind: await kindOf(object), sender: SENDER }), /not a split coin/);
});

test("withdraw: the gas coin, a publish, a non-framework call, a public_transfer or a vector are refused", async () => {
  const gas = new Transaction();
  const [fromGas] = gas.splitCoins(gas.gas, [1n]);
  gas.transferObjects([fromGas], gas.pure.address(OTHER_WALLET));
  assertRefused(evaluateWithdrawPolicy({ kind: await kindOf(gas), sender: SENDER }), /gas coin/);

  const call = withdrawal(QUOTE);
  call.moveCall({ target: `${PRESALE_PACKAGE}::anything::at_all` });
  assertRefused(evaluateWithdrawPolicy({ kind: await kindOf(call), sender: SENDER }), /anything::at_all is not allowed for intent withdraw/);

  const publicTransfer = new Transaction();
  const [coin] = publicTransfer.splitCoins(ownedCoin(publicTransfer), [1n]);
  publicTransfer.moveCall({ target: "0x2::transfer::public_transfer", typeArguments: [`0x2::coin::Coin<${QUOTE}>`], arguments: [coin, publicTransfer.pure.address(OTHER_WALLET)] });
  assertRefused(evaluateWithdrawPolicy({ kind: await kindOf(publicTransfer), sender: SENDER }), /transfer::public_transfer is not allowed for intent withdraw/);

  const vector = withdrawal(QUOTE);
  vector.makeMoveVec({ type: "u64", elements: [vector.pure.u64(1n)] });
  assertRefused(evaluateWithdrawPolicy({ kind: await kindOf(vector), sender: SENDER }), /MakeMoveVec is not allowed for intent withdraw/);
});

test("withdraw: change sent anywhere but back to the sender, or funds drawn from the sponsor, are refused", async () => {
  const change = withdrawal(QUOTE);
  const [coin] = change.splitCoins(ownedCoin(change, "d5"), [1n]);
  change.moveCall({ target: "0x2::coin::send_funds", typeArguments: [QUOTE], arguments: [coin, change.pure.address(OTHER_WALLET)] });
  assertRefused(evaluateWithdrawPolicy({ kind: await kindOf(change), sender: SENDER }), /coin::send_funds argument 1 is not the sender/);

  const kind = await kindOf(withdrawal(QUOTE), { source: "address balance" });
  const index = kind.ProgrammableTransaction!.inputs.findIndex((input) => input.$kind === "FundsWithdrawal");
  assert.ok(index >= 0, "the address-balance withdrawal redeems funds");
  const fromSponsor = structuredClone(kind);
  fromSponsor.ProgrammableTransaction!.inputs[index].FundsWithdrawal!.withdrawFrom = { $kind: "Sponsor", Sponsor: true };
  assertRefused(evaluateWithdrawPolicy({ kind: fromSponsor, sender: SENDER }), /withdraws from Sponsor/);
});

test("withdraw: a coin fanned out into many, or several coins in one transfer, is refused (sponsored storage)", async () => {
  const fanOut = new Transaction();
  const coins = fanOut.splitCoins(ownedCoin(fanOut), Array.from({ length: 40 }, () => 1n));
  fanOut.transferObjects(Array.from({ length: 40 }, (_, index) => coins[index]!), fanOut.pure.address(SENDER));
  assertRefused(evaluateWithdrawPolicy({ kind: await kindOf(fanOut), sender: SENDER }), /sends exactly one coin, not 40/);

  const split = new Transaction();
  const [kept, sent] = split.splitCoins(ownedCoin(split), [1n, 1n]);
  split.mergeCoins(ownedCoin(split, "d5"), [kept!]);
  split.transferObjects([sent!], split.pure.address(OTHER_WALLET));
  assertRefused(evaluateWithdrawPolicy({ kind: await kindOf(split), sender: SENDER }), /splits off 2 coins, more than 1/);
});

test("commit: a coin fanned out into more splits than a commit needs is refused (sponsored storage)", async () => {
  const tx = sdkCommit("open");
  tx.splitCoins(ownedCoin(tx), Array.from({ length: 5 }, () => 1n));
  assertRefused(evaluateSponsorPolicy(request(await kindOf(tx))), /splits off \d+ coins, more than 4/);
});

test("withdraw: a shared object as a coin, or a split by a non-literal amount, is refused", async () => {
  const kind = await kindOf(withdrawal(QUOTE), { source: "owned coins" });
  const shared = structuredClone(kind);
  const owned = shared.ProgrammableTransaction!.inputs.findIndex((input) => input.Object?.ImmOrOwnedObject);
  assert.ok(owned >= 0);
  shared.ProgrammableTransaction!.inputs[owned] = {
    $kind: "Object",
    Object: { $kind: "SharedObject", SharedObject: { objectId: `0x${"5e".repeat(32)}`, initialSharedVersion: "3", mutable: true } },
  } as never;
  assertRefused(evaluateWithdrawPolicy({ kind: shared, sender: SENDER }), /not an owned object/);

  const result = new Transaction();
  const [amount] = result.moveCall({ target: "0x2::coin::zero", typeArguments: [QUOTE] });
  const [split] = result.splitCoins(ownedCoin(result), [amount]);
  result.transferObjects([split], result.pure.address(OTHER_WALLET));
  assertRefused(evaluateWithdrawPolicy({ kind: await kindOf(result), sender: SENDER }), /SplitCoins amount is not a pure u64/);
});
