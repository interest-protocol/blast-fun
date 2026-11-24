import { z } from "zod";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";

/** The SDK artifact that records the presale ABI and the contracts commit it is pinned to. */
const PRESALE_ABI_ARTIFACT = "abi/production-presale-v1.json";

export type ReleaseCheckResult = Readonly<{ passed: boolean; lines: readonly string[] }>;

function head(directory: string): string | null {
  const result = spawnSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** How many uncommitted or untracked paths the worktree has (ignored files excluded), or null when git cannot tell. */
function uncommittedCount(directory: string): number | null {
  const result = spawnSync("git", ["-C", directory, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

function pinnedPresaleCommit(sdkDirectory: string): string | null {
  try {
    const artifact = JSON.parse(readFileSync(join(sdkDirectory, PRESALE_ABI_ARTIFACT), "utf8")) as {
      baseline?: { contractsCommit?: unknown };
    };
    const commit = artifact.baseline?.contractsCommit;
    return z.string().safeParse(commit).data ?? null;
  } catch {
    return null;
  }
}

/**
 * The presale release gate. It passes only when:
 *
 * 1. the SDK worktree is at the identity's `sdkCommit`, with no uncommitted
 *    or untracked content;
 * 2. the contracts worktree is at the identity's `contractsCommit`, with no
 *    uncommitted or untracked content;
 * 3. that SDK's presale ABI artifact is pinned to the same `contractsCommit`;
 * 4. the SDK's `npm run check:abi`, given the contracts worktree, exits 0.
 *
 * Every failed step is reported; nothing is written to either worktree. A
 * dirty SDK worktree's `check:abi` is not run: its scripts and artifacts are
 * not the named commit's.
 */
export function runPresaleReleaseCheck(input: Readonly<{
  identity: PresaleRuntimeIdentity;
  sdkDirectory: string;
  contractsDirectory: string;
}>): ReleaseCheckResult {
  const sdk = resolve(input.sdkDirectory);
  const contracts = resolve(input.contractsDirectory);
  const { sdkCommit, contractsCommit } = input.identity;
  const lines: string[] = [];
  let passed = true;
  const fail = (line: string) => {
    passed = false;
    lines.push(`FAIL ${line}`);
  };

  const sdkHead = head(sdk);
  if (sdkHead !== sdkCommit) fail(`the SDK worktree is at ${sdkHead ?? "no commit"}, the identity names sdkCommit ${sdkCommit}`);
  const sdkChanges = uncommittedCount(sdk);
  if (sdkChanges !== 0) fail(`the SDK worktree has uncommitted changes (${sdkChanges ?? "unknown"} paths): it is not sdkCommit`);
  const contractsHead = head(contracts);
  if (contractsHead !== contractsCommit) {
    fail(`the contracts worktree is at ${contractsHead ?? "no commit"}, the identity names contractsCommit ${contractsCommit}`);
  }
  const contractsChanges = uncommittedCount(contracts);
  if (contractsChanges !== 0) {
    fail(`the contracts worktree has uncommitted changes (${contractsChanges ?? "unknown"} paths): it is not contractsCommit`);
  }
  const pinned = pinnedPresaleCommit(sdk);
  if (pinned !== contractsCommit) {
    fail(`the SDK's presale ABI (${PRESALE_ABI_ARTIFACT}) is pinned to ${pinned ?? "no commit"}, not contractsCommit ${contractsCommit}`);
  }
  if (sdkChanges === 0) {
    const abi = spawnSync("npm", ["run", "--silent", "check:abi", "--", contracts], { cwd: sdk, encoding: "utf8" });
    const output = `${abi.stdout ?? ""}${abi.stderr ?? ""}`.trim();
    if (output) lines.push(...output.split("\n").map((line) => `  check:abi | ${line}`));
    if (abi.status !== 0) fail(`the SDK's npm run check:abi failed (exit ${abi.status ?? abi.signal ?? "unknown"})`);
  } else {
    fail("the SDK's npm run check:abi was not run on a dirty SDK worktree");
  }

  lines.push(passed ? `presale release check passed: SDK ${sdkCommit} with contracts ${contractsCommit}` : "presale release check FAILED");
  return { passed, lines };
}
