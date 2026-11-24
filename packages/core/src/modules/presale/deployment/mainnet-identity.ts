import type { PresaleDeploymentState, PresaleRuntimeIdentity } from "./contracts.ts";

/** The mainnet identity in force, or null when unavailable. */
export function mainnetIdentity(state: PresaleDeploymentState): PresaleRuntimeIdentity | null {
  return state.status === "ready" ? state.identity : null;
}
