// Pass step 1 for the buyback operator: the stack's deployment check
// (`evaluateWorkerAccess`: the selected deployment, its manifest, the node and
// the SDK's protocol access), then what only this key needs, every pass:
//
// - `no-migrators-package`: the deployment has no migrators to buy back with;
// - `release-gate-open` / `release-gate-unreadable`: the owner's checks for
//   this network, deployment, key and cap are not all recorded as passed;
// - `admin-cap-not-owned`: the configured AdminCap is not the key's;
// - `admin-cap-roles`: the ACL does not grant that cap `BuybackAdmin` alone
//   (revoked, never granted, or holding any other role);
// - `admin-unreadable`: the cap or the ACL could not be read.
//
// Any reason blocks the pass: nothing is signed or planned.

import { VAULT_PAUSE_BITS } from "@interest-protocol/blast-vault-sdk/transactions";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import type { Pool } from "pg";

import type { WorkerConfig } from "#workers/modules/worker-runtime/config.ts";
import { evaluateWorkerAccess } from "#workers/modules/worker-runtime/deployment.ts";
import { boundedProvider } from "#workers/modules/worker-runtime/provider.ts";
import type { AccessCheck, BlockedAccess, ProtocolWorkerAccess } from "#workers/modules/worker-runtime/runtime.ts";
import type { WorkerLog } from "#workers/modules/worker-runtime/log.ts";
import { adminCapStanding } from "#workers/modules/worker-runtime/admin.ts";
import { buybackRole } from "./chain.ts";
import { readReleaseGate } from "#workers/modules/worker-runtime/release-gate.ts";

export const BUYBACK_ACCESS_LOGS = Object.freeze({ releaseGate: "buyback.release_gate" });

/** A buyback pass's verdict: the stack's, with the release gate passed and the cap checked. */
export type BuybackAccess = ProtocolWorkerAccess;

function blocked(network: string, reason: string): BlockedAccess {
  return Object.freeze({ status: "blocked", network, reasons: Object.freeze([reason]) });
}

export function buybackAccessCheck({
  config,
  client,
  pool,
  log,
  signerAddress,
  adminCapId,
  stack = () => evaluateWorkerAccess(config, client),
}: Readonly<{
  config: WorkerConfig;
  client: ClientWithCoreApi;
  pool: Pool;
  log: WorkerLog;
  signerAddress: string;
  adminCapId: string;
  /** Tests only: the stack's deployment check. */
  stack?: () => ReturnType<typeof evaluateWorkerAccess>;
}>): AccessCheck<BuybackAccess> {
  const provider = boundedProvider(config.timings.providerTimeoutMs);
  return async () => {
    const access = await stack();
    if (access.status === "blocked") return access;
    const { deployment, fingerprint } = access;
    const network = deployment.network;
    if ((access.protocol.paused.vault & VAULT_PAUSE_BITS.Admin) !== 0) return blocked(network, "vault-admin-paused");
    if (!deployment.packages.migrators || !deployment.sharedObjects.migrators) return blocked(network, "no-migrators-package");
    try {
      const missing = await readReleaseGate(pool, { role: "vault-buyback", network, fingerprint, signerAddress, adminCapId });
      if (missing.length > 0) {
        log(BUYBACK_ACCESS_LOGS.releaseGate, { status: "open", missing: missing.join(",") });
        return blocked(network, "release-gate-open");
      }
    } catch {
      return blocked(network, "release-gate-unreadable");
    }
    try {
      const standing = await adminCapStanding(client, deployment, adminCapId, signerAddress, buybackRole(deployment), provider);
      if (standing === "not-owned") return blocked(network, "admin-cap-not-owned");
      if (standing === "wrong-roles") return blocked(network, "admin-cap-roles");
    } catch {
      return blocked(network, "admin-unreadable");
    }
    return access;
  };
}
