import assert from "node:assert/strict";
import test from "node:test";
import { defineBlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, SUI_TYPE_ARG, normalizeSuiAddress } from "@mysten/sui/utils";
import { manifestWithVenues } from "../../../test/fixtures/final-stack/venue-deployment.ts";
import { addressBalanceGas } from "../../../test/fixtures/modules/worker-runtime/address-balance-gas.ts";
import { keeperTransaction, assertKeeperActionOnly, type KeeperActionIntent } from "./transactions.ts";
import { loadKeeperSigner, SignerRefusal } from "./signer.ts";

const deployment = defineBlastDeployment(manifestWithVenues(["cetus", "bluefin", "aftermathDao"]));
const key = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(91));
const budget = 50_000_000n;
const ref = (value: string) => ({ objectId: normalizeSuiAddress(value), initialSharedVersion: "1" });
const pair = { memeType: normalizeStructTag("0x123::meme::MEME"), quoteType: normalizeStructTag(SUI_TYPE_ARG), object: ref("0xa") };
const actions: KeeperActionIntent[] = [
  { kind: "launch-migrate", ...pair, creationFeeMist: "0", venue: "cetus", currency: ref("0xb") },
  { kind: "presale-migrate", ...pair, creationFeeMist: "0", venue: "bluefin", currency: ref("0xb"), quoteCurrency: ref("0xc") },
  { kind: "presale-settle", ...pair }, { kind: "presale-cancel", ...pair },
  { kind: "launch-fees", ...pair, partner: null }, { kind: "launch-fees", ...pair, partner: ref("0xc") },
  { kind: "presale-partner", ...pair, partner: ref("0xc") }, { kind: "vault-partner", ...pair, partner: ref("0xc") },
  { kind: "vault-fees", ...pair, currency: ref("0xb"), pool: ref("0xd"), venue: "cetus", settleFeeSplit: false },
  { kind: "vault-fees", ...pair, currency: ref("0xb"), pool: ref("0xd"), venue: "bluefin", settleFeeSplit: true },
  { kind: "presale-vendor-migrate", ...pair, lpType: normalizeStructTag("0x456::lp::LP"), poolCreation: ref("0xe") },
];
async function bytes(tx: Transaction) {
  addressBalanceGas(tx, { sender: key.toSuiAddress(), gasBudgetMist: budget, chainIdentifier: deployment.chainIdentifier });
  return tx.build();
}
for (const [index, intent] of actions.entries()) {
  test(`keeper signs only canonical SDK bytes: ${index} ${intent.kind}`, async () => {
    const transaction = keeperTransaction(deployment, intent);
    const encoded = await bytes(transaction);
    await assertKeeperActionOnly(encoded, key.toSuiAddress(), [intent], deployment, budget);
    // An extra transfer is refused, even if a different source prepares it.
    const altered = Transaction.from(encoded);
    altered.moveCall({ target: "0x2::coin::zero", typeArguments: [pair.quoteType] });
    await assert.rejects(assertKeeperActionOnly(await bytes(altered), key.toSuiAddress(), [intent], deployment, budget), SignerRefusal);
  });
}
test("migration is the product migrate followed by its adapter in one PTB", () => {
  for (const intent of actions.filter((value) => value.kind === "launch-migrate" || value.kind === "presale-migrate" || value.kind === "presale-vendor-migrate")) {
    const calls = keeperTransaction(deployment, intent).getData().commands.flatMap((command) => command.MoveCall ? [command.MoveCall] : []);
    const migrated = calls.filter((call) => call.function.startsWith("migrate"));
    assert.equal(migrated.length, 2);
    assert.equal(migrated[0]!.function, "migrate");
    assert.equal(migrated[1]!.arguments.some((argument) => argument.$kind === "Result" || argument.$kind === "NestedResult"), true);
  }
});
test("keeper refuses privileged key co-location and a different sender", async () => {
  assert.throws(() => loadKeeperSigner({ BLAST_WORKER_SIGNER_KEY: key.getSecretKey(), VAULT_REWARDS_SIGNER_KEY: key.getSecretKey() }, { gasBudgetMist: budget, creationFeeCapMist: 0n }), /VAULT_REWARDS_SIGNER_KEY must not be set/);
  const encoded = await bytes(keeperTransaction(deployment, actions[0]!));
  await assert.rejects(assertKeeperActionOnly(encoded, normalizeSuiAddress("0xdead"), [actions[0]!], deployment, budget), SignerRefusal);
});

for (const kind of ["launch-migrate", "presale-migrate"] as const) {
  test(`${kind} funds the exact bounded Bluefin creation fee from sender balance`, async () => {
    const intent: KeeperActionIntent = { kind, ...pair, venue: "bluefin", currency: ref("0xb"), quoteCurrency: ref("0xc"), creationFeeMist: "12345" };
    const transaction = keeperTransaction(deployment, intent);
    const encoded = await bytes(transaction);
    const data = Transaction.from(encoded).getData();
    // Contract a1a8f6c, bluefin.move migrate: argument 9 is creation_fee: Coin<SUI>.
    // coin::redeem_funds returns Coin<SUI>; balance::redeem_funds returns Balance<SUI>.
    const redeemIndex = data.commands.findIndex((command) => command.MoveCall?.function === "redeem_funds");
    const redeem = data.commands[redeemIndex]!.MoveCall!;
    assert.equal(redeem.package, normalizeSuiAddress("0x2"));
    assert.equal(redeem.module, "coin", "the adapter requires a Coin, so balance::redeem_funds is invalid");
    assert.deepEqual(redeem.typeArguments, [normalizeStructTag(SUI_TYPE_ARG)]);
    const adapter = data.commands.find((command) => command.MoveCall?.module === "bluefin" && command.MoveCall.function === "migrate")!.MoveCall!;
    assert.deepEqual(adapter.arguments[9], { $kind: "Result", Result: redeemIndex });
    const withdrawals = data.inputs.filter((input) => input.$kind === "FundsWithdrawal");
    assert.equal(withdrawals.length, 1);
    assert.equal(withdrawals[0]!.FundsWithdrawal.reservation.MaxAmountU64, "12345");
    assert.equal(withdrawals[0]!.FundsWithdrawal.withdrawFrom.$kind, "Sender");
    await assertKeeperActionOnly(encoded, key.toSuiAddress(), [intent], deployment, budget, 12345n);
    await assert.rejects(assertKeeperActionOnly(encoded, key.toSuiAddress(), [intent], deployment, budget, 12344n), SignerRefusal);
    await assert.rejects(assertKeeperActionOnly(encoded, key.toSuiAddress(), [intent], deployment, budget), SignerRefusal);
    const extra = Transaction.from(encoded);
    extra.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: ["0x2::sui::SUI"], arguments: [extra.withdrawal({ amount: 1n })] });
    await assert.rejects(assertKeeperActionOnly(await bytes(extra), key.toSuiAddress(), [intent], deployment, budget, 12345n), SignerRefusal);
    const signer = loadKeeperSigner({ BLAST_WORKER_SIGNER_KEY: key.getSecretKey() }, { gasBudgetMist: budget, creationFeeCapMist: 12345n });
    assert.ok((await signer.signActions(encoded, [intent], deployment)).signature);
  });
}
