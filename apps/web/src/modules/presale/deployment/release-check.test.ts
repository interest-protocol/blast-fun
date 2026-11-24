import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { presaleIdentityFixture } from "../../../../../../packages/core/test/fixtures/modules/presale/deployment/fixtures.ts";

/**
 * T-008 (AC-006): the release check runs the SDK's `npm run check:abi` from an
 * SDK worktree at the identity's `sdkCommit` against a contracts worktree at
 * its `contractsCommit`, and blocks (nonzero exit) on any mismatch. The repos
 * here are fixtures: the SDK's `check:abi` passes only when the contracts
 * tree holds the ABI its presale artifact records.
 */

const WEB = fileURLToPath(new URL("../../../../", import.meta.url));

function git(directory: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commitAll(directory: string, message: string): string {
  git(directory, "add", "-A");
  git(directory, "-c", "user.email=fixture@example.test", "-c", "user.name=fixture", "commit", "-q", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}

function repository(root: string, name: string, files: Record<string, string>): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "-q");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  return directory;
}

/** A fixture SDK whose check:abi compares the contracts tree's presale ABI with its own artifact. */
function sdkFiles(pinnedCommit: string, abi: string): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "fixture-sdk", private: true, scripts: { "check:abi": "node scripts/check-contract-abi.mjs" } }),
    "abi/production-presale-v1.json": JSON.stringify({ schemaVersion: 1, baseline: { contractsCommit: pinnedCommit }, abi }),
    "scripts/check-contract-abi.mjs": `
      import { readFileSync } from "node:fs";
      import { join } from "node:path";
      const contracts = process.argv[2];
      const artifact = JSON.parse(readFileSync(new URL("../abi/production-presale-v1.json", import.meta.url), "utf8"));
      const actual = readFileSync(join(contracts, "sui/presale/ABI"), "utf8").trim();
      if (actual !== artifact.abi) { console.error("production Move ABI differs"); process.exit(1); }
      console.log("abi matches");
    `,
  };
}

function releaseCheck(identity: Record<string, unknown>, sdk: string, contracts: string) {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", "../../scripts/test-tsx-hooks.mjs", "--experimental-strip-types", "scripts/presale-release-check.ts", "--sdk", sdk, "--contracts", contracts],
    { cwd: WEB, encoding: "utf8", env: { ...process.env, PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(identity) } },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("the release check passes a matching SDK and contracts pair and blocks every mismatch", () => {
  const root = mkdtempSync(join(tmpdir(), "presale-release-check-"));
  try {
    const contracts = repository(root, "contracts", { "sui/presale/ABI": "abi-v1\n" });
    const published = commitAll(contracts, "publish presale");
    writeFileSync(join(contracts, "sui/presale/ABI"), "abi-v2\n");
    const changed = commitAll(contracts, "change the presale ABI");

    const sdk = repository(root, "sdk", sdkFiles(published, "abi-v1"));
    const sdkCommit = commitAll(sdk, "sdk pinned to the published presale");
    git(contracts, "checkout", "-q", published);
    const identity = presaleIdentityFixture({ contractsCommit: published, sdkCommit });

    const pass = releaseCheck(identity, sdk, contracts);
    assert.equal(pass.status, 0, pass.output);
    assert.match(pass.output, /release check passed/);

    // Uncommitted or untracked content in either worktree is not the named commit (Q-001, B-003).
    const artifact = join(sdk, "abi/production-presale-v1.json");
    const pinnedArtifact = readFileSync(artifact, "utf8");
    writeFileSync(artifact, JSON.stringify({ baseline: { contractsCommit: published }, abi: "abi-v1", edited: true }));
    const dirtySdk = releaseCheck(identity, sdk, contracts);
    assert.equal(dirtySdk.status, 1, dirtySdk.output);
    assert.match(dirtySdk.output, /SDK worktree has uncommitted changes/);
    assert.doesNotMatch(dirtySdk.output, /release check passed/);
    writeFileSync(artifact, pinnedArtifact);
    writeFileSync(join(sdk, "scripts/local-override.mjs"), "export {};");
    const untrackedSdk = releaseCheck(identity, sdk, contracts);
    assert.equal(untrackedSdk.status, 1, untrackedSdk.output);
    assert.match(untrackedSdk.output, /SDK worktree has uncommitted changes/);
    rmSync(join(sdk, "scripts/local-override.mjs"));
    writeFileSync(join(contracts, "sui/presale/ABI"), "abi-v1-edited\n");
    const dirtyContracts = releaseCheck(identity, sdk, contracts);
    assert.equal(dirtyContracts.status, 1, dirtyContracts.output);
    assert.match(dirtyContracts.output, /contracts worktree has uncommitted changes/);
    git(contracts, "checkout", "--", "sui/presale/ABI");
    writeFileSync(join(contracts, "sui/presale/NOTES"), "untracked");
    const untrackedContracts = releaseCheck(identity, sdk, contracts);
    assert.equal(untrackedContracts.status, 1, untrackedContracts.output);
    assert.match(untrackedContracts.output, /contracts worktree has uncommitted changes/);
    rmSync(join(contracts, "sui/presale/NOTES"));
    assert.equal(releaseCheck(identity, sdk, contracts).status, 0, "clean again, the pair passes");

    // The contracts worktree is not at the identity's commit.
    git(contracts, "checkout", "-q", changed);
    const wrongContracts = releaseCheck(identity, sdk, contracts);
    assert.equal(wrongContracts.status, 1, wrongContracts.output);
    assert.match(wrongContracts.output, /contracts worktree/);

    // The identity names a contracts commit the SDK's presale ABI is not pinned to.
    const unpinned = releaseCheck({ ...identity, contractsCommit: changed }, sdk, contracts);
    assert.equal(unpinned.status, 1, unpinned.output);
    assert.match(unpinned.output, /pinned/);

    // The SDK worktree is not at the identity's commit.
    git(contracts, "checkout", "-q", published);
    writeFileSync(join(sdk, "README"), "later");
    commitAll(sdk, "a later SDK commit");
    const wrongSdk = releaseCheck(identity, sdk, contracts);
    assert.equal(wrongSdk.status, 1, wrongSdk.output);
    assert.match(wrongSdk.output, /SDK worktree/);

    // The SDK's own check:abi fails: its artifact no longer matches the contracts.
    writeFileSync(join(sdk, "abi/production-presale-v1.json"), JSON.stringify({ baseline: { contractsCommit: published }, abi: "abi-v0" }));
    const failingAbi = releaseCheck({ ...identity, sdkCommit: commitAll(sdk, "stale artifact") }, sdk, contracts);
    assert.equal(failingAbi.status, 1, failingAbi.output);
    assert.match(failingAbi.output, /check:abi failed/);

    // No identity, or no paths: blocked.
    assert.equal(releaseCheck({ schemaVersion: 2 }, sdk, contracts).status, 1);
    const usage = spawnSync(process.execPath, ["--no-warnings", "--import", "../../scripts/test-tsx-hooks.mjs", "--experimental-strip-types", "scripts/presale-release-check.ts"], {
      cwd: WEB,
      encoding: "utf8",
    });
    assert.equal(usage.status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
