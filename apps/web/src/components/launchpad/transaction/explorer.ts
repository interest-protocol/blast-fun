import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import { isValidTransactionDigest } from "@mysten/sui/utils";
import { isLoopbackHostname } from "@blast/core/lib/loopback.ts";

/**
 * The explorer page of a completed transaction, built only from the accepted
 * deployment's configured explorer base (`<base>/tx/<digest>`). An invalid
 * base or digest yields no link rather than a guessed one. Plain http is
 * accepted only for a non-production explorer on a loopback host.
 */
export function explorerTransactionUrl(
  deployment: Pick<BlastDeployment, "environment" | "explorer">,
  digest: string,
): string | null {
  if (!isValidTransactionDigest(digest)) return null;
  let base: URL;
  try {
    base = new URL(deployment.explorer.baseUrl);
  } catch {
    return null;
  }
  const secure = base.protocol === "https:";
  const localHttp =
    base.protocol === "http:" && deployment.environment === "non-production" && isLoopbackHostname(base.hostname);
  if ((!secure && !localHttp) || base.username || base.password || base.search || base.hash) return null;
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}/tx/${digest}`;
}
