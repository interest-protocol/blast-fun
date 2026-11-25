import { WebSocket } from "undici";
import { BLAST_INFRA_KEY_HEADER, blastInfraApiKey, blastInfraSocketUrl } from "@blast/core/modules/read-routing/blast-infra.ts";

import type { RelaySocket } from "../../launchpad-market/stream-relay.ts";

if (typeof window !== "undefined") throw new Error("Activity hint relay is server-only.");

export function openActivitySocket(): RelaySocket {
  const key = blastInfraApiKey();
  if (!key) throw new Error("Activity hints require the server's infra key.");
  const url = blastInfraSocketUrl();
  // Undici refuses redirects, keeping the key on the configured origin.
  return new WebSocket(url, { headers: { [BLAST_INFRA_KEY_HEADER]: key } });
}
