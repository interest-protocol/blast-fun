import "server-only";

import type { LaunchPageContext } from "@blast/core/modules/social/contracts/launch.ts";
import { readPrivateBackendPage } from "./private-page-read.ts";

const UNAVAILABLE: LaunchPageContext = { rules: null, publish: { available: false, reasons: ["launch_config"] } };

/** A failed backend read disables launching so the page can still render. */
export async function readLaunchContextFromBackend(): Promise<LaunchPageContext> {
  try {
    const response = await readPrivateBackendPage("/api/social/launch-context");
    if (!response.ok) {
      await response.body?.cancel();
      return UNAVAILABLE;
    }
    return (await response.json()) as LaunchPageContext;
  } catch {
    return UNAVAILABLE;
  }
}
