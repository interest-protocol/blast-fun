import type { LaunchIssue } from "@blast/core/modules/social/launch/model.ts";
import { blockedLine } from "../create/create-review-model";
import type { LaunchState } from "./launch-store";

const FIX_PLACE: Readonly<Record<LaunchIssue["section"], string>> = { coin: "the coin", curve: "the curve", split: "the token split", pool: "the pool", fees: "the pool fees", details: "the details", buy: "the first buy" };

/**
 * Why Launch is disabled, in one line that names only what is missing:
 * "Add a name and a logo to launch.", "Fix the pool fees to launch.". Null
 * while Launch is open, loading or already launching.
 */
export function launchBlockedReason(state: LaunchState, issues: readonly LaunchIssue[]): string | null {
  if (state.phase !== "ready" || state.publishing) return null;
  const { draft } = state;
  const missing = [
    draft.name.trim() ? null : "a name",
    draft.symbol.trim() ? null : "a ticker",
    state.logoUrl || state.logoPreview ? null : "a logo",
  ].filter((item): item is string => item !== null);
  const named = new Set(["logo", ...(draft.name.trim() ? [] : ["name"]), ...(draft.symbol.trim() ? [] : ["symbol"])]);
  const places = [...new Set(issues.filter((issue) => !named.has(issue.path)).map((issue) => FIX_PLACE[issue.section]))];
  const uploading = state.logoPreview !== null || state.coverPreview !== null;
  return blockedLine(missing, places, "launch") ?? (uploading ? "Wait for the images to finish uploading." : null);
}
