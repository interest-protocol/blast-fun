import { PresaleClient } from "@interest-protocol/blast-sdk/presale";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeStructTag } from "@mysten/sui/utils";

import type { PresaleDeploymentState } from "@blast/core/modules/presale/deployment/contracts.ts";
import { recordPresaleMetric } from "@blast/core/modules/presale/redaction/redaction.ts";

/** The Quote types the current creation policy allows, normalized; null when unknown. */
export type AllowedQuotes = () => Promise<readonly string[] | null>;

/** How long a create waits for the creation policy before skipping the Quote warning. */
export const CREATION_POLICY_TIMEOUT_MS = 3_000;

/**
 * Reads the deployment's `CreationPolicy` through the SDK's `PresaleClient`.
 * The Quote warning is advisory, so nothing here fails a create: with no
 * identity or no node the answer is null without a read, and a read that
 * fails or takes longer than `timeoutMs` is null with a metric.
 */
export function creationPolicyQuotes(input: Readonly<{
  state: PresaleDeploymentState;
  /** The node's Core API client, or null when none is configured. */
  client: () => ClientWithCoreApi | null;
  timeoutMs?: number;
}>): AllowedQuotes {
  const timeoutMs = input.timeoutMs ?? CREATION_POLICY_TIMEOUT_MS;
  return async () => {
    if (input.state.status !== "ready") return null;
    const client = input.client();
    if (!client) return null;
    const presale = new PresaleClient(client, input.state.identity.presale);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const policy = await Promise.race([
        presale.getCreationPolicy(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("creation policy read timed out")), timeoutMs);
        }),
      ]);
      return policy.allowedQuotes.map((quote) => normalizeStructTag(quote));
    } catch {
      recordPresaleMetric("presale.allowlist", { outcome: "policy_unavailable" });
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
