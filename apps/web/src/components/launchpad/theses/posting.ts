import type { WebConfig } from "#web/lib/web-config.ts";

import type { ThesesPosting } from "./theses-model.ts";

/**
 * What the coin page's post form needs, from the server's settings: the
 * deployment's network for direct wallets (`BLAST_NETWORK` with
 * `BLAST_DEPLOYMENT_FINGERPRINT`, the deployment the write checks), Privy
 * when `PRIVY_APP_ID` is set, and the request's CSP nonce. Without a named
 * deployment the page offers no signer.
 */
export function thesesPosting(config: Pick<WebConfig, "expectedDeployment" | "privyAppId">, nonce: string): ThesesPosting {
  const expected = config.expectedDeployment;
  if (!expected) return { unavailable: "Posting is unavailable here: this app does not name its Blast deployment." };
  return { network: expected.network, privyAppId: config.privyAppId, nonce };
}
