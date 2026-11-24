// The presale release gate (T-008): `npm run presale:release-check -- --sdk
// <SDK worktree> --contracts <contracts worktree> [--manifest <identity.json>]`.
// The identity is the manifest file, or PRESALE_DEPLOYMENT_MANIFEST. Exit 0
// passes; 1 blocks the release; 2 is a usage error. See docs/presale/foundation.md.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { runPresaleReleaseCheck } from "../src/modules/presale/deployment/release-check.ts";
import { readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";

let values: { sdk?: string; contracts?: string; manifest?: string };
try {
  ({ values } = parseArgs({
    options: { sdk: { type: "string" }, contracts: { type: "string" }, manifest: { type: "string" } },
  }));
} catch {
  values = {};
}
if (!values.sdk || !values.contracts) {
  console.error("usage: npm run presale:release-check -- --sdk <SDK worktree> --contracts <contracts worktree> [--manifest <identity.json>]");
  process.exit(2);
}

const environment = values.manifest
  ? { ...process.env, PRESALE_DEPLOYMENT_MANIFEST: readFileSync(values.manifest, "utf8") }
  : process.env;
const state = readPresaleDeploymentIdentity(environment);
if (state.status !== "ready") {
  console.error(`FAIL no presale deployment identity: ${state.reason}`);
  process.exit(1);
}
const result = runPresaleReleaseCheck({ identity: state.identity, sdkDirectory: values.sdk, contractsDirectory: values.contracts });
for (const line of result.lines) (result.passed ? console.log : console.error)(line);
process.exit(result.passed ? 0 : 1);
