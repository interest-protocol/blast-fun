import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { normalizeStructTag } from "@mysten/sui/utils";
import { z } from "zod";
import { SUI_COIN_TYPE } from "../../../packages/core/src/lib/sui/coin-types.ts";
import {
  dayInterval,
  parseFrontendFeeHistory,
} from "../../../packages/core/src/modules/defillama/contracts.ts";
import { collectFrontendFees } from "../../../packages/core/src/modules/defillama/frontend-source.ts";
import type { FrontendFee } from "../../../packages/core/src/modules/defillama/frontend-fees.ts";

const amount = z.string().regex(/^[1-9][0-9]*$/);
const receipt = z.strictObject({
  id: z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]+:(event|command):(?:0|[1-9][0-9]*)$/),
  venue: z.enum(["cetus", "aftermath"]),
  coin: z.string().min(1),
  amount,
});
// A null amount is unknown: launchpad revenue for a coin whose partner share is set at claim time.
const breakdown = z.record(z.string(), z.record(z.string(), amount.nullable()));
const inputSchema = z.strictObject({
  date: z.string(),
  first_checkpoint: z.number().int().positive().safe(),
  policy_evidence: z.string().min(1),
  receipt_evidence: z.string().min(1),
  expected_receipts: z.array(receipt),
  publication: z.object({
    date: z.string(),
    snapshot_id: z.string().min(1),
    start_timestamp: z.number(),
    end_timestamp: z.number(),
    frontend_fee_coverage: z.object({
      status: z.literal("complete"),
      reason: z.null(),
    }),
    frontend_fee_policy: z.unknown(),
    source: z.object({
      checkpoint: z.string().regex(/^[1-9][0-9]*$/),
      digest: z.string().min(1),
    }),
  }),
  fees: z.object({
    date: z.string(),
    snapshot_id: z.string().min(1),
    dailyFees: breakdown,
    dailyRevenue: breakdown,
    dailySupplySideRevenue: breakdown,
  }),
});
const boundary = z.object({
  sequenceNumber: z.number().int().nonnegative(),
  digest: z.string(),
  timestamp: z.string(),
});
const boundaries = z.object({
  chainIdentifier: z.literal("4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"),
  beforeStart: boundary,
  start: boundary,
  beforeEnd: boundary,
  end: boundary,
});
const boundaryQuery = `query FeeDayBoundaries($beforeStart: UInt53!, $start: UInt53!, $beforeEnd: UInt53!, $end: UInt53!) {
  chainIdentifier
  beforeStart: checkpoint(sequenceNumber: $beforeStart) { sequenceNumber digest timestamp }
  start: checkpoint(sequenceNumber: $start) { sequenceNumber digest timestamp }
  beforeEnd: checkpoint(sequenceNumber: $beforeEnd) { sequenceNumber digest timestamp }
  end: checkpoint(sequenceNumber: $end) { sequenceNumber digest timestamp }
}`;

type Archive = Pick<SuiGraphQLClient, "query">;

/** The expected receipts must be independently transcribed from the public chain. */
export async function reconcileFrontendDay(
  client: Archive,
  value: unknown,
  now = Date.now(),
) {
  const input = inputSchema.parse(value);
  const interval = dayInterval(input.date, now);
  const { publication, fees, first_checkpoint: first } = input;
  const end = Number(publication.source.checkpoint);
  if (
    !Number.isSafeInteger(end) ||
    end <= first ||
    publication.date !== input.date ||
    fees.date !== input.date ||
    publication.snapshot_id !== fees.snapshot_id ||
    publication.start_timestamp !== interval.start / 1000 ||
    publication.end_timestamp !== interval.end / 1000
  ) {
    throw new Error("Publication interval or identity mismatch");
  }
  const history = parseFrontendFeeHistory(publication.frontend_fee_policy);
  const result = await client.query({
    query: boundaryQuery,
    variables: {
      beforeStart: first - 1,
      start: first,
      beforeEnd: end - 1,
      end,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (result.errors?.length) throw new Error("Checkpoint boundary unavailable");
  const checkpoints = boundaries.parse(result.data);
  if (
    checkpoints.beforeStart.sequenceNumber !== first - 1 ||
    checkpoints.start.sequenceNumber !== first ||
    checkpoints.beforeEnd.sequenceNumber !== end - 1 ||
    checkpoints.end.sequenceNumber !== end ||
    checkpoints.end.digest !== publication.source.digest ||
    !spans(
      checkpoints.beforeStart.timestamp,
      checkpoints.start.timestamp,
      interval.start,
    ) ||
    !spans(
      checkpoints.beforeEnd.timestamp,
      checkpoints.end.timestamp,
      interval.end,
    )
  ) {
    throw new Error("Checkpoint boundaries do not match the UTC day");
  }
  const collected = await collectFrontendFees(
    client,
    history,
    first,
    publication.source,
  );
  if (collected.coverage.status !== "complete")
    throw new Error("Frontend archive or policy incomplete");
  const expected = input.expected_receipts.map((row) => ({
    ...row,
    coin: normalizeStructTag(row.coin),
    amount: BigInt(row.amount),
  }));
  assertSameReceipts(expected, collected.fees);
  const totals = receiptTotals(expected);
  for (const provider of ["cetus", "aftermath"] as const) {
    const expectedTotals = totals[provider];
    if (
      !sameTotals(expectedTotals, fees.dailyFees[provider] ?? {}) ||
      !sameTotals(expectedTotals, fees.dailyRevenue[provider] ?? {}) ||
      Object.keys(fees.dailySupplySideRevenue[provider] ?? {}).length !== 0
    ) {
      throw new Error(`Published ${provider} amounts do not match receipts`);
    }
  }
  return {
    date: input.date,
    snapshot_id: publication.snapshot_id,
    receipts: expected.length,
    totals,
  };
}

function spans(previous: string, next: string, boundaryMs: number): boolean {
  const a = Date.parse(previous),
    b = Date.parse(next);
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    a < boundaryMs &&
    b >= boundaryMs
  );
}

function assertSameReceipts(
  expected: FrontendFee[],
  actual: FrontendFee[],
): void {
  const byId = new Map(expected.map((row) => [row.id, row]));
  if (
    byId.size !== expected.length ||
    actual.length !== expected.length ||
    new Set(actual.map((row) => row.id)).size !== actual.length
  ) {
    throw new Error("Duplicate or missing receipt");
  }
  for (const row of actual) {
    const match = byId.get(row.id);
    if (
      !match ||
      match.venue !== row.venue ||
      match.coin !== row.coin ||
      match.amount !== row.amount
    ) {
      throw new Error("Receipt does not match independent evidence");
    }
  }
}

function receiptTotals(receipts: FrontendFee[]) {
  const totals: Record<"cetus" | "aftermath", Record<string, string>> = {
    cetus: {},
    aftermath: {},
  };
  for (const { venue, coin, amount: atoms } of receipts) {
    const token = coin === SUI_COIN_TYPE ? "sui:0x2::sui::SUI" : `sui:${coin}`;
    totals[venue][token] = (
      BigInt(totals[venue][token] ?? "0") + atoms
    ).toString();
  }
  return totals;
}

function sameTotals(
  expected: Record<string, string>,
  published: Record<string, string | null>,
): boolean {
  return (
    Object.keys(expected).length === Object.keys(published).length &&
    Object.entries(expected).every(
      ([token, atoms]) => published[token] === atoms,
    )
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const path = process.argv[2];
    const url = process.env.DEFILLAMA_SUI_ARCHIVE_GRAPHQL_URL;
    if (!path || process.argv.length !== 3 || !url)
      throw new Error("Input file and archive URL required");
    const input: unknown = JSON.parse(await readFile(path, "utf8"));
    const client = new SuiGraphQLClient({ network: "mainnet", url });
    console.log(
      JSON.stringify(await reconcileFrontendDay(client, input), null, 2),
    );
    console.log(
      "Receipt and policy provenance remain operator-reviewed; this comparison does not prove them.",
    );
  } catch {
    // The archive URL or provider errors may contain credentials.
    console.error(
      "Reconciliation failed. Check the input, UTC boundaries, archive coverage and independently reviewed receipts.",
    );
    process.exitCode = 1;
  }
}
