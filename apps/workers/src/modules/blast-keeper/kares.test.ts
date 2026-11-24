import assert from "node:assert/strict";
import test from "node:test";
import { getBlastDeployment, presaleDeployment } from "@interest-protocol/blast-deployments-sdk";
import { protocolFeesPaidBcs } from "@interest-protocol/blast-core/protocol-fees";
import { presaleEventBcs } from "@interest-protocol/blast-presale-sdk/events";
import type { PresaleState } from "@interest-protocol/blast-presale-sdk/state";
import { addressBalanceGas } from "../../../test/fixtures/modules/worker-runtime/address-balance-gas.ts";
import { kares, karesReady, karesPayoutsMatch } from "./kares.ts";
import { assertKeeperActionOnly, keeperTransaction } from "./transactions.ts";

const deployment = getBlastDeployment("mainnet");
const intent = { kind: "kares-migrate", object: kares.object, memeType: kares.memeType, quoteType: kares.quoteType, settle: true } as const;
const venue = "0x58f45e1b3057be882ebd991e67cb81e9543acf123f0013c5011b918413525d1f::blast_aftermath_dao_presale::Venue";
test("only the filled KARES sale and its own reservation qualify", () => {
  const sale = { objectId: kares.object.objectId, saleTokenType: kares.memeType, quoteType: kares.quoteType, venue, raiseTarget: 60_000_000_000_000n, totalCommitments: 60_000_000_000_000n } as PresaleState;
  assert.equal(karesReady(sale, kares.poolCreation.objectId), true);
  assert.equal(karesReady({ ...sale, totalCommitments: sale.raiseTarget - 1n }, kares.poolCreation.objectId), false);
  assert.equal(karesReady({ ...sale, objectId: kares.poolCreation.objectId }, kares.poolCreation.objectId), false);
  assert.equal(karesReady(sale, null), false);
});

test("the keeper admits the single mainnet migration and binds settlement to the intent", async () => {
  const sender = kares.object.objectId;
  const budget = 100_000_000n;
  const tx = keeperTransaction(deployment, intent);
  const calls = tx.getData().commands.map(command => command.MoveCall?.function);
  assert.deepEqual(calls, ["settle", "migrate", "migrate", "protocol_version"]);
  addressBalanceGas(tx, { sender, gasBudgetMist: budget, chainIdentifier: deployment.chainIdentifier });
  const bytes = await tx.build();
  await assertKeeperActionOnly(bytes, sender, [intent], deployment, budget);
  await assert.rejects(assertKeeperActionOnly(bytes, sender, [{ ...intent, settle: false }], deployment, budget), /match|unexpected|differ|intent/);
});

test("the KARES keeper refuses a diverted protocol fee or a missing treasury payout", () => {
  const id = kares.object.objectId;
  const ares = "0x37cf46b499f740e653644bd2f7a8ed97f248e8b3c69d5d12c97d7845a54c0cd8";
  const blast = "0x818d6d7026632f82367a9ca2413a5bb28aeec2a1b8dedca919ef812577b4d0a2";
  const base = presaleDeployment(deployment);
  const types = `<${kares.memeType},${kares.quoteType}>`;
  const fee = (treasury: string) => ({
    eventType: base.core.originalPackageId + "::blast_core_events::ProtocolFeesPaid" + types,
    bcs: protocolFeesPaidBcs.serialize({
      package_witness: base.originalPackageId + "::blast_presale_package::PackageWitness",
      origin: id, treasury, meme_amount: 0n, quote_amount: 1_200_000_000_000n, sui_amount: 0n,
      partner_id: null, partner_meme_amount: 0n, partner_quote_amount: 0n, partner_sui_amount: 0n,
    }).toBytes(),
  });
  const payout = (recipient: string, quote: bigint) => ({
    eventType: base.originalPackageId + "::events::RaiseAllocated" + types,
    bcs: presaleEventBcs.RaiseAllocated.serialize({ presale_id: id, recipient, quote, vesting_id: null }).toBytes(),
  });
  const cash = [payout(ares, 34_200_000_000_000n), payout(blast, 600_000_000_000n)];
  const tokens = {
    eventType: base.originalPackageId + "::events::RecipientAllocated" + types,
    bcs: presaleEventBcs.RecipientAllocated.serialize({ presale_id: id, recipient: ares, tokens: 440_000_000_000_000_000n, vesting_id: null }).toBytes(),
  };
  assert.equal(karesPayoutsMatch([fee(blast), ...cash, tokens]), true);
  assert.equal(karesPayoutsMatch([fee(ares), ...cash, tokens]), false);
  assert.equal(karesPayoutsMatch([fee(blast), cash[0]!, tokens]), false);
});
