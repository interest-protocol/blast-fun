// Resolve the verified Blob URL for a published launch or presale vault round.
import type { Pool } from "pg";

import { expectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import type { PublishedManifests } from "./routes.ts";

export function postgresPublishedManifests(pool: Pool): PublishedManifests {
  return Object.freeze({
    async publishedManifestUrl(roundId: string) {
      const selection = expectedDeployment();
      if (!selection) return null;
      const reader = autocommitReader(pool, "presale-planner");
      const { rows } = await reader.read<{ url: string | null }>(
        "SELECT vault_published_reward_manifest($1,$2,$3) AS url",
        [selection.network, selection.deployment, roundId],
      );
      return rows[0]?.url ?? null;
    },
  });
}
