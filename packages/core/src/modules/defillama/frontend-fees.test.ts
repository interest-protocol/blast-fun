import assert from "node:assert/strict";
import test from "node:test";
import type { SuiGraphQLClient } from "@mysten/sui/graphql";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { AFTERMATH_DAO_PACKAGE, AFTERMATH_DAO_SWAP_CALL } from "../sponsor/aftermath-dao.ts";
import { DefillamaAccounting } from "./accounting.ts";
import { parseFrontendFeeHistory, type FrontendFeePolicy } from "./contracts.ts";
import { objectId, end, meme, profile, quote, start } from "./fixtures.test.ts";
import { readAftermathFees, readCetusFee } from "./frontend-fees.ts";
import { collectFrontendFees } from "./frontend-source.ts";

const router = "0xffd4058af7d6f6d66c335930cced8c91e38ec943e2392232aee27e8127e684e9";
const recipient = objectId("7");
const policy: FrontendFeePolicy = {
  first_checkpoint: 100,
  end_checkpoint_exclusive: 103,
  receivers: [recipient],
  cetus_packages: [router],
  aftermath_package: AFTERMATH_DAO_PACKAGE,
};
const cut = { checkpoint: "103", digest: "finalized-cut" };
const overlay = {
  sequenceNumber: 4,
  transactionModule: { package: { address: router } },
  contents: {
    type: { repr: `${router}::router::ConfirmSwapEventV3` },
    json: { target: quote.slice(2), fee_amount: "42171", fee_recipient: recipient, fee_rate: 3000 },
  },
};

async function aftermath(options: { sponsor?: boolean; suffix?: boolean; wrongSource?: boolean; suffixFee?: number; unrelated?: boolean } = {}) {
  const tx = new Transaction();
  tx.setSender(objectId("1"));
  tx.setGasOwner(objectId(options.sponsor ? "2" : "1"));
  tx.setGasPrice(1000);
  tx.setGasBudget(10_000_000);
  tx.setGasPayment([{ objectId: objectId("3"), version: 1, digest: "11111111111111111111111111111111" }]);
  const coin = tx.objectRef({ objectId: objectId("4"), version: 1, digest: "11111111111111111111111111111111" });
  const shared = AFTERMATH_DAO_SWAP_CALL.sharedObjects.map(({ objectId: id }) =>
    tx.sharedObjectRef({ objectId: id ?? objectId("5"), initialSharedVersion: 1, mutable: true }));
  const dao = tx.moveCall({
    target: `${AFTERMATH_DAO_PACKAGE}::${AFTERMATH_DAO_SWAP_CALL.target}`,
    typeArguments: [`${objectId("6")}::lp::LP`, quote, meme],
    arguments: [...shared, coin, tx.pure.u64(900), tx.pure.u64(0)],
  });
  let output = dao;
  if (options.suffix) {
    const context = tx.moveCall({
      target: `${router}::router::new_swap_context_v3`,
      typeArguments: [meme, quote],
      arguments: [
        tx.pure.string(""), tx.pure.u64(0), tx.pure.u64(900), tx.pure.u64(800), tx.pure.u64(0),
        dao, tx.pure.u32(options.suffixFee ?? 0), tx.pure.address("0x0"),
      ],
    });
    output = tx.moveCall({
      target: `${router}::router::confirm_swap_v3`, typeArguments: [quote], arguments: [context],
    });
  }
  if (options.unrelated) {
    tx.transferObjects([output], recipient);
  } else {
    const [fee] = tx.splitCoins(options.wrongSource ? tx.gas : output, [tx.pure.u64(9007199254740993n)]);
    tx.transferObjects([fee!], recipient);
    tx.transferObjects([output], objectId("1"));
  }
  const bytes = await tx.build();
  return { digest: TransactionDataBuilder.getDigestFromBytes(bytes), transactionBcs: toBase64(bytes) };
}

test("counts only Aftermath's exact output split for wallet-paid and sponsored swaps", async () => {
  for (const options of [{}, { sponsor: true, suffix: true }]) {
    const receipt = await aftermath(options);
    assert.deepEqual(readAftermathFees(receipt.digest, receipt.transactionBcs, policy), [{
      id: `${receipt.digest}:command:${options.suffix ? 4 : 2}`,
      venue: "aftermath",
      coin: options.suffix ? quote : meme,
      amount: 9007199254740993n,
    }]);
  }
  for (const options of [{ wrongSource: true }, { unrelated: true }, { suffix: true, suffixFee: 1 }]) {
    const receipt = await aftermath(options);
    assert.deepEqual(readAftermathFees(receipt.digest, receipt.transactionBcs, policy), []);
    assert.throws(() => readAftermathFees("bad-digest", receipt.transactionBcs, policy), /digest/);
  }
});

test("Cetus uses the settled overlay amount and checks recipient and emitter", () => {
  const { contents, sequenceNumber } = overlay;
  const read = (type = contents.type.repr, emitter = router, json = contents.json) =>
    readCetusFee("digest", sequenceNumber, type, emitter, json, policy);
  assert.deepEqual(read(), { id: "digest:event:4", venue: "cetus", coin: quote, amount: 42171n });
  assert.equal(read(undefined, undefined, { ...contents.json, fee_recipient: objectId("8") }), null);
  assert.equal(read(undefined, undefined, { ...contents.json, fee_amount: "0" }), null);
  assert.equal(read(`${router}::pool::SwapEvent`), null);
  assert.throws(() => read(undefined, objectId("8")), /emitter/);
});

function mockArchive(data: Record<string, unknown>[]) {
  const requests: unknown[] = [];
  return {
    requests,
    client: {
      query: async ({ variables }) => {
        requests.push(variables);
        const next = data.shift();
        assert.ok(next, "unexpected archive request");
        return { data: next };
      },
    } as Pick<SuiGraphQLClient, "query">,
  };
}

const range = { first: { sequenceNumber: 100 }, last: { sequenceNumber: 103 } };
const archive = {
  chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  checkpoint: { digest: cut.digest },
  serviceConfig: { transactions: range, bcs: range, events: range },
};
const lastPage = { hasNextPage: false, endCursor: null };

test("receiver-index pages deduplicate executed receipts and exclude failed transactions", async () => {
  const receipt = await aftermath({ suffix: true, sponsor: true });
  const transaction = {
    ...receipt,
    effects: { status: "SUCCESS", checkpoint: { sequenceNumber: 102 }, events: { pageInfo: lastPage, nodes: [] } },
  };
  const cetus = {
    ...await aftermath({ unrelated: true }),
    effects: { ...transaction.effects, events: { pageInfo: lastPage, nodes: [overlay] } },
  };
  const { client, requests } = mockArchive([
    archive,
    { transactions: { nodes: [transaction], pageInfo: { hasNextPage: true, endCursor: "next" } } },
    { transactions: { nodes: [transaction, cetus, { ...cetus, digest: "failed", effects: { ...cetus.effects, status: "FAILURE" } }], pageInfo: lastPage } },
  ]);
  const frontend = await collectFrontendFees(client, [policy], 100, cut);
  assert.deepEqual(frontend.coverage, { status: "complete", reason: null });
  assert.deepEqual(frontend.fees.map(({ venue }) => venue).sort(), ["aftermath", "cetus"]);
  assert.deepEqual(requests[1], {
    cursor: null, filter: { affectedAddress: recipient, afterCheckpoint: 99, beforeCheckpoint: 103 },
  });

  const accounting = new DefillamaAccounting(profile, start, end);
  accounting.addFrontendFees(frontend.fees);
  const [row] = accounting.result().items;
  assert.equal(row?.component, "frontend_router_fees");
  assert.equal(row.underlying_venue_overlap, false);
  assert.equal(row.metrics.fees, "9007199254783164");
  assert.equal(row.metrics.fees, row.metrics.revenue);
  assert.equal(row.metrics.fees, row.metrics.protocol_revenue);
  assert.equal(row.metrics.volume, "0");
  assert.equal(row.metrics.supply_side_revenue, "0");
  assert.equal(row.evidence.cetus_paid, "42171");
  assert.equal(row.evidence.aftermath_paid, "9007199254740993");
});

test("gaps, pruned indexes, wrong cuts and incomplete pagination never turn into zero fees", async () => {
  const history = parseFrontendFeeHistory([policy]);
  const gap = await collectFrontendFees(undefined, history, 99, cut);
  assert.equal(gap.coverage.reason, "frontend_fee_policy_incomplete");
  assert.equal((await collectFrontendFees(undefined, history, 100, cut)).coverage.reason, "frontend_fee_source_incomplete");
  assert.equal((await collectFrontendFees(undefined, [{ ...policy, receivers: [] }], 100, cut)).coverage.status, "complete");

  for (const pages of [
    [{ ...archive, checkpoint: { digest: "different" } }],
    [{ ...archive, serviceConfig: { ...archive.serviceConfig, bcs: { ...range, first: { sequenceNumber: 101 } } } }],
    [archive, { transactions: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } }],
  ]) {
    const { client } = mockArchive(pages);
    const result = await collectFrontendFees(client, history, 100, cut);
    assert.equal(result.coverage.reason, "frontend_fee_source_incomplete");
    assert.deepEqual(result.fees, []);
  }
});
