import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  aggregateSnapshot,
  aggregateSnapshotV3,
  type Snapshot,
  type SnapshotV3,
} from "./contract.ts";

export function createAnalyticsHandler(
  token: string,
  loadSnapshot: () => Promise<Snapshot | null>,
  loadV3?: () => Promise<SnapshotV3 | null>,
) {
  if (token.length < 32 || token.length > 4096 || /\s/.test(token)) {
    throw new Error(
      "ANALYTICS_API_TOKEN must be 32–4096 non-whitespace characters",
    );
  }
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      respond(405, { error: "method_not_allowed" });
      return;
    }
    if (request.url === "/live") {
      respond(200, { status: "live" });
      return;
    }
    const actual = createHash("sha256")
      .update(request.headers.authorization ?? "")
      .digest();
    if (!timingSafeEqual(expected, actual)) {
      respond(401, { error: "unauthorized" });
      return;
    }
    if (request.url === "/v3/summary" && loadV3) {
      try {
        const snapshot = await loadV3();
        if (!snapshot) {
          throw new Error();
        }
        const payload = aggregateSnapshotV3.parse(snapshot.payload);
        const now = BigInt(Date.now());
        const generated = snapshot.generated_at.getTime();
        const publicationStale =
          !Number.isSafeInteger(generated) ||
          BigInt(generated) > now ||
          now - BigInt(generated) > 3600000n;
        const staleAt = (value: string) =>
          BigInt(value) > now || now - BigInt(value) > 3600000n;
        const chainStale =
          publicationStale ||
          staleAt(payload.asOfTimestampMs) ||
          staleAt(payload.chainPublicationTimestampMs);
        const accountStale =
          publicationStale || staleAt(payload.accountObservationTimestampMs);
        respond(200, {
          ...payload,
          generatedAt: snapshot.generated_at.toISOString(),
          chainStale,
          accountStale,
          stale: chainStale || accountStale,
        });
      } catch {
        respond(503, { error: "snapshot_unavailable" });
      }
      return;
    }
    if (request.url !== "/v1/summary") {
      respond(404, { error: "not_found" });
      return;
    }
    try {
      const snapshot = await loadSnapshot();
      if (!snapshot) {
        respond(503, { error: "snapshot_unavailable" });
        return;
      }
      const payload = aggregateSnapshot.parse(snapshot.payload);
      const asOf = Number(payload.asOfTimestampMs);
      const generatedAt = snapshot.generated_at.getTime();
      const now = Date.now();
      const stale =
        !Number.isSafeInteger(asOf) ||
        asOf > now ||
        generatedAt > now ||
        now - asOf > 3_600_000 ||
        now - generatedAt > 3_600_000;
      respond(200, {
        ...payload,
        generatedAt: snapshot.generated_at.toISOString(),
        stale,
      });
    } catch {
      respond(503, { error: "snapshot_unavailable" });
    }
    function respond(status: number, body: unknown): void {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    }
  };
}
