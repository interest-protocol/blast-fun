import { PresaleClient } from "@interest-protocol/blast-sdk/presale";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeStructTag } from "@mysten/sui/utils";
import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import { optionalSource } from "../optional-source.ts";

/** A failed policy read disables publishing until the deployed policy can be checked. */
export function readCreationPolicy(
  client: () => ClientWithCoreApi | null,
  identity: PresaleRuntimeIdentity,
) {
  return optionalSource(
    "creation_policy",
    async () => {
      const node = client();
      if (!node) return null;
      const policy = await new PresaleClient(node, identity.presale).getCreationPolicy();
      return {
        quotes: policy.allowedQuotes.map((type) => normalizeStructTag(type)),
        witnesses: policy.venues.map((type) => normalizeStructTag(type)),
      };
    },
    null,
  );
}
