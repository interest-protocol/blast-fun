import { PresaleClient, type EligibilityPolicy } from "@interest-protocol/blast-sdk/presale";
import { ObjectError, type ClientWithCoreApi } from "@mysten/sui/client";

import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import { recordPresaleMetric } from "@blast/core/modules/presale/redaction/redaction.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";

/** A sale's on-chain eligibility, or null when the deployment has no presale with that ID. */
export type PresaleEligibilityReader = (identity: PresaleRuntimeIdentity, presaleId: string) => Promise<EligibilityPolicy | null>;

/** How long a bind or proof waits for the sale's object before answering `deployment_unavailable`. */
export const PRESALE_READ_TIMEOUT_MS = 3_000;

/** The SDK's own refusals of an object that is not a shared presale of the deployment's package. */
const NOT_A_PRESALE = /^object 0x[0-9a-f]{64} is not (?:shared|a presale Presale)$/;

/**
 * Reads a sale with the SDK's `PresaleClient.getPresale` under the deployment
 * identity. A missing object, an owned object or another type is no presale
 * (null). No node, a failed read or one slower than `timeoutMs` is
 * `deployment_unavailable`: the node is the deployment's, as the gate says.
 */
export function presaleEligibilityReader(input: Readonly<{
  /** The node's Core API client, or null when none is configured. */
  client: () => ClientWithCoreApi | null;
  timeoutMs?: number;
}>): PresaleEligibilityReader {
  const timeoutMs = input.timeoutMs ?? PRESALE_READ_TIMEOUT_MS;
  return async (identity, presaleId) => {
    const client = input.client();
    if (!client) throw new PresaleRouteError("deployment_unavailable");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const presale = await Promise.race([
        new PresaleClient(client, identity.presale).getPresale(presaleId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("presale read timed out")), timeoutMs);
        }),
      ]);
      return presale.eligibility;
    } catch (error) {
      if (error instanceof ObjectError && error.reason === "notFound") return null;
      if (error instanceof TypeError && NOT_A_PRESALE.test(error.message)) return null;
      recordPresaleMetric("presale.allowlist", { outcome: "presale_read_failed" });
      throw new PresaleRouteError("deployment_unavailable");
    } finally {
      clearTimeout(timer);
    }
  };
}
