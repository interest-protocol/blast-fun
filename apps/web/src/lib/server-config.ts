import "server-only";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";

import { parseWebConfig, type WebConfig } from "./web-config.ts";

/** The web process's settings, parsed from `process.env` on first use (`web-config.ts`). */
export function webConfig(): WebConfig {
  return processSingleton("webConfig", () => parseWebConfig(process.env));
}
