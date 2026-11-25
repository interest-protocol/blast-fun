import { observeMetric } from "@blast/core/lib/metrics.ts";
import { boundedText } from "@blast/server/modules/launchpad-telemetry/http.ts";
import { parseTimingReport } from "#web/lib/live-stream/live-timing.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 2_048;
const BODY_DEADLINE_MS = 5_000;

/** One sampled tab's minute of hop timing (`live-timing.ts`), logged as one metric line. */
export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_CHARS) return new Response(null, { status: 413 });
  const read = await boundedText(request, MAX_BODY_CHARS, BODY_DEADLINE_MS);
  if ("refused" in read) return new Response(null, { status: read.refused });
  let body: unknown = null;
  try {
    body = JSON.parse(read.text);
  } catch { /* refused below */ }
  const report = parseTimingReport(body);
  if (!report) return new Response(null, { status: 400 });
  const fields: Record<string, string | number> = { transport: report.transport };
  if (report.offset_rtt_ms !== null) fields.offset_rtt_ms = report.offset_rtt_ms;
  for (const [segment, stats] of Object.entries(report.hops)) {
    fields[`${segment}_n`] = stats.n;
    fields[`${segment}_p50`] = stats.p50;
    fields[`${segment}_p95`] = stats.p95;
  }
  observeMetric("live.timing", fields);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
