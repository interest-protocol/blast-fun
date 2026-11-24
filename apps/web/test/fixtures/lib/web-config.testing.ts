import type { TestContext } from "node:test";

import { processSingleton, takeProcessSingleton } from "@blast/core/lib/process-singleton.ts";

import type { RelayConfig } from "@blast/server/private/relay-config.ts";

import { parseWebConfig, type WebConfig } from "../../../src/lib/web-config.ts";

/**
 * Tests only: `webConfig()` answers the config parsed from `environment`, and
 * `relayConfig()` its relay part, until the test ends; then the process's
 * previous configs (or none) are restored.
 */
export function useWebConfig(t: TestContext, environment: Readonly<Record<string, string | undefined>>): WebConfig {
  const previous = takeProcessSingleton<WebConfig>("webConfig");
  const previousRelay = takeProcessSingleton<RelayConfig>("relayConfig");
  const config = processSingleton("webConfig", () => parseWebConfig(environment));
  processSingleton("relayConfig", () => config.relay);
  t.after(() => {
    takeProcessSingleton("webConfig");
    takeProcessSingleton("relayConfig");
    if (previous !== undefined) processSingleton("webConfig", () => previous);
    if (previousRelay !== undefined) processSingleton("relayConfig", () => previousRelay);
  });
  return config;
}
