import { readAnalyticsConfig } from "../src/modules/analytics/config.ts";
import { refreshAnalytics } from "../src/modules/analytics/refresh.ts";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  const config = readAnalyticsConfig(process.env);
  const outcome = config === null ? "disabled" : await refreshAnalytics(config, controller.signal);
  console.log(JSON.stringify({ metric: "analytics.refresh", outcome }));
} catch {
  console.error(JSON.stringify({ metric: "analytics.refresh_failed" }));
  process.exitCode = 1;
}
