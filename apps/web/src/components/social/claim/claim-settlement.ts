import { tabActivityHints } from "#web/components/social/home/activity-hints.ts";

/** A missed live signal gets one private re-read after the indexer has caught up. */
export const CLAIM_FALLBACK_POLL_MS = 18_000;

export function watchClaimSettlement(refresh: () => void | Promise<void>): () => void {
  let stopped = false;
  const look = () => {
    void Promise.resolve().then(() => { if (!stopped) return refresh(); }).catch(() => undefined);
  };
  const off = tabActivityHints()?.subscribe("claim-settlement", look);
  const timer = setTimeout(look, CLAIM_FALLBACK_POLL_MS);
  return () => {
    stopped = true;
    off?.();
    clearTimeout(timer);
  };
}
