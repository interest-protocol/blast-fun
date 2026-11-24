import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { Pool } from "pg";
import {
  DAY_SECONDS,
  DefillamaError,
  HOUR_SECONDS,
  assertPublishedProfile,
  dayInterval,
  hourStarts,
  parseFrontendFeeHistory,
  parseProfile,
  type Snapshot,
} from "../../../packages/core/src/modules/defillama/contracts.ts";
import { collectDay, collectHour } from "../../../packages/core/src/modules/defillama/source.ts";
import {
  loadReplayBase,
  publishedFeeHours,
  publishSnapshot,
  reportingReads,
  type ReplayBase,
} from "../../../packages/core/src/modules/defillama/store.ts";
import { expectedDeployment } from "../../../packages/core/src/modules/launchpad-contract/provenance.ts";

let source: Pool | undefined;
let reporting: Pool | undefined;
try {
  const now = Date.now();
  const request = publicationRequest(process.argv.slice(2), now);
  const profile = parseProfile(JSON.parse(process.env.DEFILLAMA_PROFILE ?? "null"));
  const sourceDeployment = expectedDeployment();
  assertPublishedProfile(profile, sourceDeployment);
  const sourceUrl = process.env.DEFILLAMA_SOURCE_DATABASE_URL;
  const writeUrl = process.env.DEFILLAMA_WRITE_DATABASE_URL;
  if (!sourceUrl || !writeUrl) {
    throw new Error("DefiLlama source and reporting write URLs are required");
  }
  const sourceAddress = new URL(sourceUrl),
    reportingAddress = new URL(writeUrl);
  if (
    sourceAddress.host === reportingAddress.host &&
    sourceAddress.pathname === reportingAddress.pathname
  ) {
    throw new Error("DefiLlama source and reporting databases must be separate");
  }
  source = new Pool({
    connectionString: sourceUrl,
    max: 1,
    connectionTimeoutMillis: 3000,
    query_timeout: 20_000,
    application_name: "blast-defillama-source",
  });
  reporting = new Pool({
    connectionString: writeUrl,
    max: 1,
    connectionTimeoutMillis: 3000,
    query_timeout: 20_000,
    application_name: "blast-defillama-publish",
  });
  source.on("error", () => {
    console.error("DefiLlama source connection unavailable");
  });
  reporting.on("error", () => {
    console.error("DefiLlama publisher connection unavailable");
  });
  const archiveUrl = process.env.DEFILLAMA_SUI_ARCHIVE_GRAPHQL_URL;
  const archive = archiveUrl
    ? new SuiGraphQLClient({ network: "mainnet", url: archiveUrl })
    : undefined;
  const frontendFeeHistory = parseFrontendFeeHistory(
    JSON.parse(process.env.DEFILLAMA_FRONTEND_FEE_HISTORY ?? "[]"),
  );
  const publisher = {
    source,
    reporting,
    profile,
    now,
    options: {
      archive,
      frontendFeeHistory,
      sourceFingerprint: sourceDeployment?.deployment,
    },
  };
  if (request.mode === "day") {
    await publishDay(publisher, request.date);
  } else {
    try {
      const hours =
        request.mode === "scheduled"
          ? await unpublishedHours(publisher, request.hours)
          : request.hours;
      await publishHours(publisher, hours);
    } finally {
      if (request.mode === "scheduled") {
        await ensureDailySummary(publisher, utcDate(request.end - DAY_SECONDS));
      }
    }
  }
} catch {
  // Driver/URL errors can contain credentials: never print the original cause.
  console.error(
    "DefiLlama publication failed. Check interval, source coverage, fee archive, deployment profile and database roles.",
  );
  process.exitCode = 1;
} finally {
  await Promise.all([source?.end(), reporting?.end()]);
}

function publicationRequest(args: string[], now: number) {
  if (args.length === 1 && args[0] === "--scheduled") {
    const end = Math.floor(now / (HOUR_SECONDS * 1000)) * HOUR_SECONDS;
    return {
      mode: "scheduled" as const,
      end,
      hours: hourStarts(end - DAY_SECONDS, end, now),
    };
  }
  if (args.length === 2 && args[0] === "--hours" && args[1]) {
    const { start, end } = dayInterval(args[1], now);
    return {
      mode: "hours" as const,
      hours: hourStarts(start / 1000, end / 1000, now),
    };
  }
  if (args.length === 1 && args[0]) {
    dayInterval(args[0], now);
    return { mode: "day" as const, date: args[0] };
  }
  throw new Error("Usage: defillama-publish.ts YYYY-MM-DD | --hours YYYY-MM-DD | --scheduled");
}

function utcDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

type Publisher = {
  source: Pool;
  reporting: Pool;
  profile: ReturnType<typeof parseProfile>;
  now: number;
  options: Parameters<typeof collectHour>[4];
};

async function publishDay({ source, reporting, profile, now, options }: Publisher, date: string) {
  const replayBase = await loadReplayBase(reporting, profile, date);
  await publish(
    reporting,
    await collectDay(source, profile, date, now, { ...options, replayBase }),
  );
}

async function publishHours(
  { source, reporting, profile, now, options }: Publisher,
  hours: readonly number[],
) {
  let replayBase: ReplayBase | undefined;
  let replayDate: string | undefined;
  for (const start of hours) {
    const date = utcDate(start);
    if (replayDate !== date) {
      replayBase = await loadReplayBase(reporting, profile, date);
      replayDate = date;
    }
    const snapshot = await collectHour(source, profile, start, now, {
      ...options,
      replayBase,
    });
    await publish(reporting, snapshot);
    if (snapshot.native_replay) {
      replayBase = {
        source: snapshot.source,
        state: snapshot.native_replay,
        contracts: snapshot.contracts,
      };
    }
  }
}

async function unpublishedHours({ reporting, profile }: Publisher, hours: readonly number[]) {
  const existing = await publishedFeeHours(reporting, profile, hours);
  return hours.filter((hour) => !existing.has(hour));
}

async function ensureDailySummary(publisher: Publisher, date: string) {
  const { reporting, profile } = publisher;
  const previous = await reportingReads(reporting, profile)
    .publication({ date })
    .catch((error: unknown) => {
      if (error instanceof DefillamaError && error.status === 404) {
        return undefined;
      }
      throw error;
    });
  if (!previous?.summary.daily_fees) {
    await publishDay(publisher, date);
  }
}

async function publish(reporting: Pool, snapshot: Snapshot) {
  if (snapshot.frontend_fee_coverage.status !== "complete") {
    throw new Error("Complete frontend fee policy and archive coverage are required");
  }
  const publication = await publishSnapshot(reporting, snapshot);
  console.log(
    JSON.stringify({
      date: snapshot.date,
      start_timestamp: snapshot.start_timestamp,
      end_timestamp: snapshot.end_timestamp,
      ...publication,
      items: snapshot.items.length,
      contracts: snapshot.contracts.length,
      frontend_fee_coverage: snapshot.frontend_fee_coverage,
    }),
  );
}
