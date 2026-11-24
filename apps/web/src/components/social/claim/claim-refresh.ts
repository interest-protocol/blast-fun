import type { QueryClient } from "@tanstack/react-query";
import { compareExact, exactDecimal } from "@blast/core/web/exact-amount.ts";
import type { InfiniteData } from "@tanstack/react-query";
import type { CreatorEarnings } from "@blast/core/web/contracts/creator-earnings.ts";
import type { SocialPortfolio } from "@blast/core/web/contracts/portfolio.ts";
import type { SocialMePresales } from "@blast/core/web/contracts/profile-page.ts";
import type { SocialPresaleViewerResponse } from "@blast/core/web/contracts/presales.ts";
import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { watchClaimSettlement } from "#web/components/social/claim/claim-settlement.ts";
import { queryKeys as keys } from "#web/lib/query/keys.ts";
import { claimedAfter, collectionReceiptAdvanced, type ClaimRunner } from "./claim-runner";
import { isCreatorCapsClaimTarget, isLaunchClaimTarget, type ClaimTarget } from "./claims";

/** Only private reads can prove inclusion; public sale bodies can remain CDN-cached. */
function included(client: QueryClient, target: ClaimTarget): boolean {
  if (isLaunchClaimTarget(target) || isCreatorCapsClaimTarget(target)) return true;
  const creators = client.getQueryData<InfiniteData<CreatorEarnings>>(keys.me.creatorEarnings());
  if (target.kind === "collect_fees") return creators?.pages.some((page) => page.earnings.some((row) => row.vault_id === target.vaultId && collectionReceiptAdvanced(target.collection?.received,`${row.received.meme}:${row.received.quote}`))) === true;
  if (target.kind === "claim_residuals") return creators?.pages.some((page) => page.earnings.some((row) => row.vault_id === target.vaultId && row.residuals === null)) === true;
  const holdings = client.getQueriesData<SocialMePresales>({ queryKey: keys.me.presales() }).map(([, data]) => data);
  if (target.kind === "claim_vesting") {
    const expected = claimedAfter(target);
    const creatorIncluded = creators?.pages.some((page) => page.vestings.some((row) => {
      const claimed = exactDecimal(row.claimed);
      return row.schedule_id === target.scheduleId && expected !== null && claimed !== null && compareExact(claimed,expected) >= 0;
    })) === true;
    return creatorIncluded || expected !== null && holdings.some((data) => data?.vestings?.some((schedule) => {
      const claimed = exactDecimal(schedule.claimed);
      return schedule.schedule_id === target.scheduleId && claimed !== null && compareExact(claimed, expected) >= 0;
    }));
  }
  if (holdings.some((data) => data?.positions?.some((position) => position.presale.presale_id === target.presaleId && position.status === "delivered"))) return true;
  const portfolio = client.getQueryData<SocialPortfolio>(keys.me.portfolio());
  if (portfolio?.positions?.some((position) => position.presale_id === target.presaleId && position.status === "delivered")) return true;
  return client.getQueriesData<SocialPresaleViewerResponse>({ queryKey: keys.me.presaleViewerAll })
    .some(([, data]) => data?.presales[target.presaleId]?.mine?.claimed === true);
}

/** Re-read pending claims on committed activity, with one fallback while the stream is down. */
export function watchClaimReads(runner: ClaimRunner, client: QueryClient): () => void {
  const attempts = new Map<string, { digest: string; stop(): void }>();
  const check = () => {
    for (const [key, target] of runner.pending()) {
      if (included(client, target)) runner.acknowledge(key, target.digest);
    }
    for (const [key, attempt] of attempts) {
      if (runner.pending().get(key)?.digest !== attempt.digest) {
        attempt.stop();
        attempts.delete(key);
      }
    }
    for (const [key, target] of runner.pending()) {
      if (attempts.has(key)) continue;
      const stop = watchClaimSettlement(() => invalidateAfter(client, { kind: "claim", presaleId: target.presaleId ?? null }));
      attempts.set(key, { digest: target.digest, stop });
    }
  };
  const stopRunner = runner.subscribe(check);
  const stopCache = client.getQueryCache().subscribe(check);
  check();
  return () => {
    stopRunner();
    stopCache();
    for (const attempt of attempts.values()) attempt.stop();
    attempts.clear();
  };
}
