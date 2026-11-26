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
import { FeeSummaryUnavailable } from "../../../packages/core/src/modules/defillama/daily-fees.ts";
import { collectDay, collectHour } from "../../../packages/core/src/modules/defillama/source.ts";
import {
  loadReplayBase,
  publishedFeeHours,
  publishSnapshot,
  reportingReads,
  type ReplayBase,
} from "../../../packages/core/src/modules/defillama/store.ts";
import { expectedDeployment } from "../../../packages/core/src/modules/launchpad-contract/provenance.ts";

async function main() {
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
        await publishHours(hourSteps(publisher), hours, request.mode === "scheduled");
      } finally {
        if (request.mode === "scheduled") {
          await ensureDailySummary(publisher, utcDate(request.end - DAY_SECONDS));
        }
      }
    }
  } catch (error) {
    console.error(failureLine(error));
    process.exitCode = 1;
  } finally {
    await Promise.all([source?.end(), reporting?.end()]);
  }
}

if (import.meta.main) {
  await main();
}

// Driver, URL and parser errors can contain credentials or configuration: print only our own messages.
export function failureLine(error: unknown): string {
  const own =
    error instanceof DefillamaError ||
    error instanceof FeeSummaryUnavailable ||
    (error instanceof Error && error.constructor === Error && !("code" in error));
  return own
    ? `DefiLlama publication failed: ${error.message.replace(/[a-z][a-z\d+.-]*:\/\/\S+/gi, "<url>")}`
    : "DefiLlama publication failed. Check interval, source coverage, fee archive, deployment profile and database roles.";
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

export type HourSteps = {
  replayBase(date: string): Promise<ReplayBase | undefined>;
  collect(start: number, replayBase: ReplayBase | undefined): Promise<Snapshot>;
  publish(snapshot: Snapshot): Promise<void>;
};

function hourSteps({ source, reporting, profile, now, options }: Publisher): HourSteps {
  return {
    replayBase: (date) => loadReplayBase(reporting, profile, date),
    collect: (start, replayBase) =>
      collectHour(source, profile, start, now, { ...options, replayBase }),
    publish: (snapshot) => publish(reporting, snapshot),
  };
}

/** A scheduled run skips an hour whose fees cannot be summarized; the next run retries it. */
export async function publishHours(
  steps: HourSteps,
  hours: readonly number[],
  skipUnsummarized: boolean,
) {
  let replayBase: ReplayBase | undefined;
  let replayDate: string | undefined;
  for (const start of hours) {
    const date = utcDate(start);
    if (replayDate !== date) {
      replayBase = await steps.replayBase(date);
      replayDate = date;
    }
    const snapshot = await steps.collect(start, replayBase);
    try {
      await steps.publish(snapshot);
    } catch (error) {
      if (!skipUnsummarized || !(error instanceof FeeSummaryUnavailable)) {
        throw error;
      }
      console.warn(`skipped hour ${new Date(start * 1000).toISOString()}: ${error.reason}`);
    }
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
  if (!previous?.summary.daily_fees || !previous.summary.daily_launch_stats) {
    await publishDay(publisher, date);
  }
}

async function publish(reporting: Pool, snapshot: Snapshot) {
  const { status, reason } = snapshot.frontend_fee_coverage;
  if (status !== "complete") {
    throw new FeeSummaryUnavailable(reason ?? "frontend_fee_coverage_unavailable");
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
