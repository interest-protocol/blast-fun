// Whether the worker may sign this pass: the selected deployment
// (`BLAST_NETWORK`, `BLAST_DEPLOYMENT_FINGERPRINT`), its manifest (the SDK's
// released registry in production, a manifest file otherwise), and the SDK's
// fail-closed `evaluateProtocolAccess` over what the node reports now. Any
// reason blocks signing; the reasons are short codes, never messages.

import { readFile } from "node:fs/promises";

import {
  BLAST_DEPLOYMENTS,
  defineBlastDeployment,
  deploymentFingerprint,
  evaluateProtocolAccess,
  observeDeploymentRuntime,
  type BlastDeployment,
  type BlastDeploymentInput,
  type ProtocolAccess,
} from "@interest-protocol/blast-deployments-sdk";
import type { ClientWithCoreApi } from "@mysten/sui/client";

import type { WorkerConfig } from "./config.ts";
import { bounded } from "./provider.ts";

export type WorkerNetwork = BlastDeployment["network"] | "unselected";

/** The SDK's evaluation with signing enabled: the deployment, its fingerprint and each venue's availability. */
export type EnabledProtocolAccess = Extract<ProtocolAccess, { signing: "enabled" }>;

export type WorkerAccess =
  | Readonly<{ status: "enabled"; deployment: BlastDeployment; fingerprint: string; protocol: EnabledProtocolAccess }>
  | Readonly<{ status: "blocked"; network: WorkerNetwork; reasons: readonly string[] }>;

type DeploymentConfig = Pick<WorkerConfig, "selection" | "environment" | "manifestFile"> & {
  timings: Pick<WorkerConfig["timings"], "providerTimeoutMs">;
};

function blocked(network: WorkerNetwork, ...reasons: string[]): WorkerAccess {
  return { status: "blocked", network, reasons };
}

async function manifestFor(config: DeploymentConfig, network: BlastDeployment["network"]): Promise<unknown> {
  if (config.environment === "production") return BLAST_DEPLOYMENTS[network] ?? null;
  if (!config.manifestFile) return null;
  return JSON.parse(await readFile(config.manifestFile, "utf8"));
}

export async function evaluateWorkerAccess(config: DeploymentConfig, client: ClientWithCoreApi): Promise<WorkerAccess> {
  const selection = config.selection;
  if (!selection) return blocked("unselected", "no-deployment-selected");
  let manifest: unknown;
  try {
    manifest = await manifestFor(config, selection.network);
  } catch {
    return blocked(selection.network, "invalid-manifest");
  }
  if (manifest === null) {
    return blocked(selection.network, config.environment === "production" ? "unreleased-deployment" : "no-manifest");
  }
  let deployment: BlastDeployment;
  try {
    deployment = defineBlastDeployment(manifest as BlastDeploymentInput);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return blocked(selection.network, typeof code === "string" ? code : "invalid-manifest");
  }
  if (deployment.network !== selection.network || deploymentFingerprint(deployment) !== selection.deployment) {
    return blocked(selection.network, "deployment-mismatch");
  }
  let runtime: Awaited<ReturnType<typeof observeDeploymentRuntime>>;
  try {
    runtime = await bounded(config.timings.providerTimeoutMs, () => observeDeploymentRuntime(client, deployment));
  } catch {
    return blocked(selection.network, "runtime-unverified");
  }
  const access = evaluateProtocolAccess({ manifest: deployment, mode: config.environment, runtime });
  if (access.signing === "disabled") {
    return blocked(selection.network, ...[...new Set(access.reasons.map((reason) => reason.code))]);
  }
  return { status: "enabled", deployment: access.deployment, fingerprint: access.fingerprint, protocol: access };
}
