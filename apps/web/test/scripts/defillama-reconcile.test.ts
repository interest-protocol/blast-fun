import assert from "node:assert/strict";
import test from "node:test";
import type { SuiGraphQLClient } from "@mysten/sui/graphql";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { reconcileFrontendDay } from "../../scripts/defillama-reconcile.ts";

const receiver = `0x${"7".repeat(64)}`;
const router =
  "0xffd4058af7d6f6d66c335930cced8c91e38ec943e2392232aee27e8127e684e9";
const last = { hasNextPage: false, endCursor: null };
const range = { first: { sequenceNumber: 100 }, last: { sequenceNumber: 103 } };
const checkpoint = (sequenceNumber: number, timestamp: string) => ({
  sequenceNumber,
  timestamp,
  digest: sequenceNumber === 103 ? "cut" : "other",
});
const boundaryData = {
  chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  beforeStart: checkpoint(99, "2026-11-06T23:59:59Z"),
  start: checkpoint(100, "2026-11-07T00:00:00Z"),
  beforeEnd: checkpoint(102, "2026-11-07T23:59:59Z"),
  end: checkpoint(103, "2026-11-08T00:00:00Z"),
};

async function fixture() {
  const tx = new Transaction();
  tx.setSender(receiver);
  tx.setGasOwner(receiver);
  tx.setGasPrice(1000);
  tx.setGasBudget(10_000_000);
  tx.setGasPayment([
    {
      objectId: `0x${"3".repeat(64)}`,
      version: 1,
      digest: "11111111111111111111111111111111",
    },
  ]);
  const bytes = await tx.build();
  const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
  const row = {
    digest,
    transactionBcs: toBase64(bytes),
    effects: {
      status: "SUCCESS",
      checkpoint: { sequenceNumber: 101 },
      events: {
        pageInfo: last,
        nodes: [
          {
            sequenceNumber: 4,
            transactionModule: { package: { address: router } },
            contents: {
              type: { repr: `${router}::router::ConfirmSwapEventV3` },
              json: {
                fee_recipient: receiver,
                fee_amount: "9007199254740993",
                target: "0x2::sui::SUI",
              },
            },
          },
        ],
      },
    },
  };
  const input = {
    date: "2026-11-07",
    first_checkpoint: 100,
    policy_evidence: "reviewed policy record",
    receipt_evidence: "independent event inspection",
    expected_receipts: [
      {
        id: `${digest}:event:4`,
        venue: "cetus",
        coin: "0x2::sui::SUI",
        amount: "9007199254740993",
      },
    ],
    publication: {
      date: "2026-11-07",
      snapshot_id: "snapshot",
      start_timestamp: 1794009600,
      end_timestamp: 1794096000,
      frontend_fee_coverage: { status: "complete", reason: null },
      frontend_fee_policy: [
        {
          first_checkpoint: 100,
          end_checkpoint_exclusive: 103,
          receivers: [receiver],
          cetus_packages: [router],
          aftermath_package: null,
        },
      ],
      source: { checkpoint: "103", digest: "cut" },
    },
    fees: {
      date: "2026-11-07",
      snapshot_id: "snapshot",
      dailyFees: { cetus: { "sui:0x2::sui::SUI": "9007199254740993" } },
      dailyRevenue: { cetus: { "sui:0x2::sui::SUI": "9007199254740993" } },
      dailySupplySideRevenue: {},
    },
  };
  const archive = {
    chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
    checkpoint: { digest: "cut" },
    serviceConfig: { transactions: range, bcs: range, events: range },
  };
  const responses = [
    boundaryData,
    archive,
    {
      transactions: {
        pageInfo: { hasNextPage: true, endCursor: "next" },
        nodes: [row],
      },
    },
    { transactions: { pageInfo: last, nodes: [row] } },
  ];
  const client = {
    query: async () => ({ data: responses.shift() }),
  } as unknown as SuiGraphQLClient;
  return { input, client, responses };
}

test("reconciles deduplicated settled receipts and exact published token totals", async () => {
  const { input, client } = await fixture();
  assert.deepEqual(await reconcileFrontendDay(client, input), {
    date: "2026-11-07",
    snapshot_id: "snapshot",
    receipts: 1,
    totals: {
      cetus: { "sui:0x2::sui::SUI": "9007199254740993" },
      aftermath: {},
    },
  });
});

test("rejects changed receipt amounts and duplicate expected positions", async () => {
  const changed = await fixture();
  changed.input.expected_receipts[0]!.amount = "9007199254740992";
  await assert.rejects(
    reconcileFrontendDay(changed.client, changed.input),
    /Receipt does not match independent evidence/,
  );
  const duplicate = await fixture();
  duplicate.input.expected_receipts.push(duplicate.input.expected_receipts[0]!);
  await assert.rejects(
    reconcileFrontendDay(duplicate.client, duplicate.input),
    /Duplicate or missing receipt/,
  );
});

test("rejects wrong cutoff and incomplete archive coverage", async () => {
  const wrongCut = await fixture();
  wrongCut.input.publication.source.digest = "wrong";
  await assert.rejects(
    reconcileFrontendDay(wrongCut.client, wrongCut.input),
    /Checkpoint boundaries do not match the UTC day/,
  );
  const incomplete = await fixture();
  incomplete.responses[1] = {
    ...incomplete.responses[1],
    serviceConfig: {
      transactions: range,
      bcs: { first: { sequenceNumber: 101 }, last: { sequenceNumber: 103 } },
      events: range,
    },
  };
  await assert.rejects(
    reconcileFrontendDay(incomplete.client, incomplete.input),
    /Frontend archive or policy incomplete/,
  );
});

test("rejects published provider totals that differ from the receipts", async () => {
  const { input, client } = await fixture();
  input.fees.dailyRevenue.cetus["sui:0x2::sui::SUI"] = "9007199254740992";
  await assert.rejects(
    reconcileFrontendDay(client, input),
    /Published cetus amounts do not match receipts/,
  );
});

test("rejects a boundary outside the selected UTC day and mixed snapshot revisions", async () => {
  const boundary = await fixture();
  boundary.responses[0] = {
    ...boundaryData,
    start: checkpoint(100, "2026-11-06T23:59:59Z"),
  };
  await assert.rejects(
    reconcileFrontendDay(boundary.client, boundary.input),
    /Checkpoint boundaries do not match the UTC day/,
  );
  const revision = await fixture();
  revision.input.fees.snapshot_id = "other";
  await assert.rejects(
    reconcileFrontendDay(revision.client, revision.input),
    /Publication interval or identity mismatch/,
  );
});

test("rejects a published provider fee mismatch or supply-side allocation", async () => {
  const fee = await fixture();
  fee.input.fees.dailyFees.cetus["sui:0x2::sui::SUI"] = "1";
  await assert.rejects(
    reconcileFrontendDay(fee.client, fee.input),
    /Published cetus amounts do not match receipts/,
  );
  const supply = await fixture();
  supply.input.fees.dailySupplySideRevenue = {
    cetus: { "sui:0x2::sui::SUI": "1" },
  };
  await assert.rejects(
    reconcileFrontendDay(supply.client, supply.input),
    /Published cetus amounts do not match receipts/,
  );
});
