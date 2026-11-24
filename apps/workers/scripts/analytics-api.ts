import { createServer } from "node:http";
import {
  analyticsPool,
  readApiConfig,
} from "../src/modules/analytics/config.ts";
import { createAnalyticsHandler } from "../src/modules/analytics/api.ts";
import {
  readSnapshot,
  readSnapshotV3,
} from "../src/modules/analytics/snapshot-reader.ts";

// This process receives only a snapshot-reader URL and a server-to-server token.
try {
  const config = readApiConfig(process.env);
  // Validate the token before creating even a lazy database pool.
  const handler = createAnalyticsHandler(
    config.token,
    () => readSnapshot(pool),
    config.accountReportingEnabled ? () => readSnapshotV3(pool) : undefined,
  );
  const pool = analyticsPool(config.databaseUrl, "blast-analytics-api");
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
    handler,
  );
  server.maxRequestsPerSocket = 100;
  server.listen(config.port, "0.0.0.0");
  const close = () => {
    server.close(() => {
      void pool.end();
    });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, close);
  }
  server.on("error", () => {
    void pool.end();
    process.exitCode = 1;
  });
} catch {
  console.error(JSON.stringify({ metric: "analytics.api_config_failed" }));
  process.exitCode = 1;
}
