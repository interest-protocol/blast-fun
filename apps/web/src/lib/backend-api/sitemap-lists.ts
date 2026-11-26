import "server-only";

import { unstable_cache } from "next/cache";
import { backendPrivateServerRead } from "@blast/server/private/relay.ts";
import { PRESALE_LIST_MAX_LIMIT, PRESALE_LIST_STATUSES } from "@blast/core/modules/social/contracts/presales.ts";
import { HOME_DEFAULT_WINDOW, HOME_PAGE_MAX, HOME_TRADERS_DEFAULT_QUERY, socialHomePath, socialHomeTradersPath, type HomeCoinsPage, type HomeTradersPage } from "@blast/core/modules/social/contracts/home.ts";
import { backendFirstPartyRead } from "#web/modules/partner-api/v1/relay.ts";
import { withoutTestCoins } from "#web/lib/test-launches.ts";
import { SITE_ORIGIN } from "#web/lib/site.ts";
import type { SitemapLists } from "#web/lib/sitemap-entries.ts";

import { presaleBackendPageReads } from "./presales.ts";
import { readPrivateBackendPage } from "./private-page-read.ts";

const SITEMAP_LIST_SECONDS = 3600;

/** One list, shared by every crawl for an hour. A failed read is not cached: it gives an empty list and the next crawl retries. */
async function hourly<Value>(name: string, read: () => Promise<readonly Value[]>): Promise<readonly Value[]> {
  try {
    return await unstable_cache(read, ["sitemap-lists", name], { revalidate: SITEMAP_LIST_SECONDS })();
  } catch {
    return [];
  }
}

/**
 * The first page of Home's coins, each presale tab and the traders board:
 * 5 backend reads per hour, whatever the crawl rate. A sale's coin is listed by its sale page.
 * The relays sign the caller's platform address, as the coin page's initial market read does.
 */
export async function readSitemapLists(clientAddress: string | null): Promise<SitemapLists> {
  const ingress = new Headers();
  if (clientAddress) ingress.set("x-vercel-forwarded-for", clientAddress);
  const headers = async () => new Headers(ingress);
  const json = async <Result,>(path: string): Promise<Result> => {
    const response = await readPrivateBackendPage(path, { origin: SITE_ORIGIN, headers, relay: backendPrivateServerRead });
    if (!response.ok) throw new Error("Sitemap read unavailable.");
    return await response.json() as Result;
  };
  const presales = presaleBackendPageReads({ headers, relay: backendFirstPartyRead, origin: SITE_ORIGIN });
  const [coinTypes, callsigns, ...presalePages] = await Promise.all([
    hourly("coins", async () => withoutTestCoins(await json<HomeCoinsPage>(socialHomePath({ limit: HOME_PAGE_MAX })))
      .coins.flatMap((coin) => coin.presale_id === null ? [coin.coin_type] : [])),
    hourly("traders", async () => (await json<HomeTradersPage>(socialHomeTradersPath(HOME_DEFAULT_WINDOW, { ...HOME_TRADERS_DEFAULT_QUERY, limit: HOME_PAGE_MAX })))
      .traders.flatMap(({ key }) => key.startsWith("c:") ? [key.slice(2)] : [])),
    ...PRESALE_LIST_STATUSES.map((status) => hourly(`presales:${status}`, async () =>
      (await presales.list({ status, limit: PRESALE_LIST_MAX_LIMIT })).presales.map((sale) => sale.presale_id))),
  ]);
  return { coinTypes, callsigns, presaleIds: presalePages.flat() };
}
