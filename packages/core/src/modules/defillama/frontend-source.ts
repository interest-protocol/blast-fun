import type { SuiGraphQLClient } from "@mysten/sui/graphql";
import { z } from "zod";
import type { FrontendFeeCoverage, FrontendFeePolicy } from "./contracts.ts";
import { readAftermathFees, readCetusFee, type FrontendFee } from "./frontend-fees.ts";

const MAINNET = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
const PAGE_SIZE = 20;
const MAX_REQUESTS = 500;

const checkpoint = z.object({ sequenceNumber: z.number().int().nonnegative() });
const availableRange = z.object({ first: checkpoint, last: checkpoint });
const archive = z.object({
  chainIdentifier: z.literal(MAINNET),
  checkpoint: z.object({ digest: z.string() }),
  serviceConfig: z.object({
    transactions: availableRange,
    bcs: availableRange,
    events: availableRange,
  }),
});
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const eventPage = z.object({
  pageInfo,
  nodes: z.array(z.object({
    sequenceNumber: z.number().int().nonnegative(),
    transactionModule: z.object({ package: z.object({ address: z.string() }) }),
    contents: z.object({ type: z.object({ repr: z.string() }), json: z.unknown() }),
  })),
});
const transactionPage = z.object({
  transactions: z.object({
    pageInfo,
    nodes: z.array(z.object({
      digest: z.string(),
      transactionBcs: z.string(),
      effects: z.object({
        status: z.enum(["SUCCESS", "FAILURE"]),
        checkpoint,
        events: eventPage.nullable(),
      }),
    })),
  }),
});
const additionalEvents = z.object({
  transaction: z.object({ effects: z.object({ events: eventPage }) }),
});

const ARCHIVE_QUERY = `query FrontendArchive($end: UInt53!) {
  chainIdentifier
  checkpoint(sequenceNumber: $end) { digest }
  serviceConfig {
    transactions: availableRange(type: "Query", field: "transactions", filters: ["affectedAddress", "afterCheckpoint", "beforeCheckpoint"]) {
      first { sequenceNumber } last { sequenceNumber }
    }
    bcs: availableRange(type: "Transaction", field: "transactionBcs") {
      first { sequenceNumber } last { sequenceNumber }
    }
    events: availableRange(type: "TransactionEffects", field: "events") {
      first { sequenceNumber } last { sequenceNumber }
    }
  }
}`;
const EVENT_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes { sequenceNumber transactionModule { package { address } } contents { type { repr } json } }
`;
const TRANSACTIONS_QUERY = `query FrontendTransactions($filter: TransactionFilter!, $cursor: String) {
  transactions(first: ${PAGE_SIZE}, after: $cursor, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes {
      digest transactionBcs
      effects {
        status checkpoint { sequenceNumber }
        events(first: ${PAGE_SIZE}) { ${EVENT_FIELDS} }
      }
    }
  }
}`;
const EVENTS_QUERY = `query FrontendEvents($digest: String!, $cursor: String!) {
  transaction(digest: $digest) { effects { events(first: ${PAGE_SIZE}, after: $cursor) { ${EVENT_FIELDS} } } }
}`;

type Window = { start: number; end: number; policy: FrontendFeePolicy };
type ReceiptSource = Pick<SuiGraphQLClient, "query">;

function coveredWindows(history: readonly FrontendFeePolicy[], start: number, end: number): Window[] | null {
  const windows: Window[] = [];
  let next = start;
  for (const policy of history) {
    if (policy.end_checkpoint_exclusive <= next) continue;
    if (next >= end || policy.first_checkpoint > next) break;
    const windowEnd = Math.min(policy.end_checkpoint_exclusive, end);
    windows.push({ start: next, end: windowEnd, policy });
    next = windowEnd;
  }
  return next === end ? windows : null;
}

function nextCursor(info: z.infer<typeof pageInfo>, previous: string | null): string | null {
  if (!info.hasNextPage) return null;
  if (!info.endCursor || info.endCursor === previous) throw new Error("Invalid archive cursor");
  return info.endCursor;
}

type ArchiveQuery = <T>(schema: z.ZodType<T>, document: string, variables: Record<string, unknown>) => Promise<T>;
type FeeScan = { query: ArchiveQuery; include: (fee: FrontendFee) => void };
type EventPage = z.infer<typeof eventPage>;

/** One bounded, abortable archive client per collection run. */
function archiveQuery(client: ReceiptSource): ArchiveQuery {
  const signal = AbortSignal.timeout(60_000);
  let requests = 0;
  return async (schema, document, variables) => {
    if (++requests > MAX_REQUESTS) throw new Error("Frontend fee archive request limit");
    const result = await client.query({ query: document, variables, signal });
    if (result.errors?.length) throw new Error("Incomplete Sui archive response");
    return schema.parse(result.data);
  };
}

function includeFee(fees: Map<string, FrontendFee>, fee: FrontendFee): void {
  const previous = fees.get(fee.id);
  if (previous && (previous.amount !== fee.amount || previous.coin !== fee.coin || previous.venue !== fee.venue)) {
    throw new Error("Conflicting frontend fee receipt");
  }
  fees.set(fee.id, fee);
}

function assertArchiveCovers(
  evidence: z.infer<typeof archive>,
  cut: { digest: string },
  start: number,
  end: number,
): void {
  if (evidence.checkpoint.digest !== cut.digest ||
      Object.values(evidence.serviceConfig).some((range) =>
        range.first.sequenceNumber > start || range.last.sequenceNumber < end)) {
    throw new Error("Archive does not cover the source checkpoint range");
  }
}

async function scanTransactionFees(
  scan: FeeScan,
  policy: FrontendFeePolicy,
  digest: string,
  transactionBcs: string,
  firstEvents: EventPage | null,
): Promise<void> {
  readAftermathFees(digest, transactionBcs, policy).forEach(scan.include);
  let events = firstEvents;
  let eventCursor: string | null = null;
  while (events) {
    for (const event of events.nodes) {
      const fee = readCetusFee(
        digest, event.sequenceNumber, event.contents.type.repr,
        event.transactionModule.package.address, event.contents.json, policy,
      );
      if (fee) scan.include(fee);
    }
    eventCursor = nextCursor(events.pageInfo, eventCursor);
    events = eventCursor
      ? (await scan.query(additionalEvents, EVENTS_QUERY, { digest, cursor: eventCursor })).transaction.effects.events
      : null;
  }
}

async function scanReceiverFees(
  scan: FeeScan,
  window: Window,
  receiver: string,
  visited: Set<string>,
): Promise<void> {
  let cursor: string | null = null;
  do {
    const { transactions } = await scan.query(transactionPage, TRANSACTIONS_QUERY, {
      filter: { affectedAddress: receiver, afterCheckpoint: window.start - 1, beforeCheckpoint: window.end },
      cursor,
    });
    for (const { digest, transactionBcs, effects } of transactions.nodes) {
      const at = effects.checkpoint.sequenceNumber;
      if (at < window.start || at >= window.end) throw new Error("Archive returned transaction outside window");
      if (effects.status !== "SUCCESS" || visited.has(digest)) continue;
      visited.add(digest);
      await scanTransactionFees(scan, window.policy, digest, transactionBcs, effects.events);
    }
    cursor = nextCursor(transactions.pageInfo, cursor);
  } while (cursor);
}

/** Scan the receiver index only for this day. Never infer zero from missing archive coverage. */
export async function collectFrontendFees(
  client: ReceiptSource | undefined,
  history: readonly FrontendFeePolicy[],
  start: number,
  cut: { checkpoint: string; digest: string },
): Promise<{ coverage: FrontendFeeCoverage; fees: FrontendFee[]; policy: FrontendFeePolicy[] }> {
  const end = Number(cut.checkpoint);
  const windows = coveredWindows(history, start, end);
  if (!windows) {
    return { coverage: { status: "unavailable", reason: "frontend_fee_policy_incomplete" }, fees: [], policy: [] };
  }
  const policy = windows.map((window) => ({
    ...window.policy, first_checkpoint: window.start, end_checkpoint_exclusive: window.end,
  }));
  const active = windows.filter(({ policy }) => policy.receivers.length > 0);
  const complete = { status: "complete", reason: null } as const;
  if (active.length === 0) return { coverage: complete, fees: [], policy };
  if (!client) return { coverage: { status: "unavailable", reason: "frontend_fee_source_incomplete" }, fees: [], policy };

  const fees = new Map<string, FrontendFee>();
  const scan: FeeScan = { query: archiveQuery(client), include: (fee) => includeFee(fees, fee) };

  try {
    const evidence = await scan.query(archive, ARCHIVE_QUERY, { end });
    assertArchiveCovers(evidence, cut, active[0]!.start, end);
    for (const window of active) {
      const visited = new Set<string>();
      for (const receiver of window.policy.receivers) {
        await scanReceiverFees(scan, window, receiver, visited);
      }
    }
    return { coverage: complete, fees: [...fees.values()].sort((a, b) => a.id.localeCompare(b.id)), policy };
  } catch {
    return { coverage: { status: "unavailable", reason: "frontend_fee_source_incomplete" }, fees: [], policy };
  }
}
