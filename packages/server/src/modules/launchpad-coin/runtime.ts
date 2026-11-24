import { LRUCache } from "lru-cache";
import { isValidSuiNSName, normalizeSuiNSName } from "@mysten/sui/utils";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { createSemaphore } from "@blast/server/lib/concurrency.ts";
import { trackRequestWork } from "@blast/server/lib/request-work.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { defaultMarketDataDependencies } from "@blast/core/modules/read-routing/blast-infra.ts";
import { configuredLaunchReadChain } from "@blast/server/modules/launchpad-coin/chain.ts";
import { createFreshLaunchReader } from "@blast/server/modules/launchpad-coin/fresh.ts";
import { createLastGood, type CoinPageDependencies } from "@blast/server/modules/launchpad-coin/read.ts";

function launchReadChain() {
  return processSingleton("launchpad-coin.chain", configuredLaunchReadChain);
}

const creatorNames = new LRUCache<string, { name: string | null }>({
  max: 4_096,
  ttl: 300_000,
  fetchMethod: async (address, _, { options }) => {
    try {
      const chain = await launchReadChain();
      if (!chain) return { name: null };
      const slots = processSingleton("launchpad-coin.suins-slots", () => createSemaphore(runtimeConfig().coinSuinsMaxConcurrency));
      const release = await slots.acquire(0);
      try {
        const { data: { name } } = await chain.client.core.defaultNameServiceName({ address, signal: AbortSignal.timeout(250) });
        return { name: name && isValidSuiNSName(name) ? normalizeSuiNSName(name, "dot") : null };
      } finally {
        release();
      }
    } catch {
      options.ttl = 30_000;
      return { name: null };
    }
  },
});

export async function coinCreatorName(address: string): Promise<string | null> {
  return (await creatorNames.fetch(address))?.name ?? null;
}

function configuredMarket() {
  try {
    return defaultMarketDataDependencies();
  } catch {
    // An unconfigured origin or deployment expectation: every indexed section is Unavailable.
    return null;
  }
}

/** The coin page's dependencies in this server process; the last-good sections are shared. */
export function coinPageDependencies(): Promise<CoinPageDependencies> {
  return processSingleton("launchpad-coin.dependencies", async () => ({
    market: configuredMarket(),
    readFresh: createFreshLaunchReader(await launchReadChain(), Date.now, { trackWork: trackRequestWork }),
    lastGood: createLastGood(),
  }));
}

/**
 * The configured explorer of the deployment this server reads launch objects
 * from (the released one on `BLAST_NETWORK`), for transaction links; null when none is configured.
 * `explorerTransactionUrl` still refuses an invalid base or digest.
 */
export function coinPageExplorer(): Promise<Readonly<{ environment: string; explorer: Readonly<{ baseUrl: string }> }> | null> {
  return processSingleton("launchpad-coin.explorer", async () => {
    const chain = await launchReadChain();
    const baseUrl = chain?.manifest.explorer?.baseUrl;
    return chain && baseUrl ? { environment: chain.manifest.environment, explorer: { baseUrl } } : null;
  });
}
