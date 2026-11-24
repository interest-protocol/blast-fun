import { createServer } from "node:http";
import { createAccessRedeemer } from "./access.ts";
import { authConfig } from "./auth.ts";
import { createDashboardHandler } from "./handler.ts";
import { createSummaryReader } from "./summary.ts";

try {
  const config = authConfig(process.env);
  const load = createSummaryReader(
    process.env.ANALYTICS_API_URL ?? "",
    process.env.ANALYTICS_API_TOKEN ?? "",
    { development: process.env.NODE_ENV === "development" },
  );
  const rawPort = process.env.PORT ?? "8080";
  const port = Number(rawPort);
  if (!/^[0-9]+$/.test(rawPort) || port < 1 || port > 65535)
    throw new Error("Invalid port");
  const access = createAccessRedeemer(
    process.env.ANALYTICS_ACCESS_DATABASE_URL ?? "",
  );
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000 },
    createDashboardHandler(config, load, access.redeem),
  );
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 64;
  server.on("error", () => {
    console.error("Analytics dashboard could not start");
    void access.close();
    process.exitCode = 1;
  });
  server.listen(
    port,
    process.env.NODE_ENV === "development" ? "127.0.0.1" : "0.0.0.0",
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      server.close(() => {
        void access.close().finally(() => process.exit(0));
      });
      setTimeout(() => {
        server.closeAllConnections();
        void access.close().finally(() => process.exit(0));
      }, 5000).unref();
    });
} catch {
  console.error("Analytics dashboard configuration is incomplete or invalid");
  process.exitCode = 1;
}
