import "server-only";

import { backendPrivateServerRead } from "@blast/server/private/relay.ts";
import { PRESALE_LIST_MAX_LIMIT, PRESALE_LIST_STATUSES } from "@blast/core/modules/social/contracts/presales.ts";
import { HOME_DEFAULT_WINDOW, HOME_PAGE_MAX, HOME_TRADERS_DEFAULT_QUERY, socialHomePath, socialHomeTradersPath, type HomeCoinsPage, type HomeTradersPage } from "@blast/core/modules/social/contracts/home.ts";
import { backendFirstPartyRead } from "#web/modules/partner-api/v1/relay.ts";
import { withoutTestCoins } from "#web/lib/test-launches.ts";
import { SITE_ORIGIN } from "#web/lib/site.ts";
import type { SitemapLists } from "#web/lib/sitemap-entries.ts";

import { presaleBackendPageReads } from "./presales.ts";
import { readPrivateBackendPage, type BackendPageReadDependencies } from "./private-page-read.ts";

// No request headers: the sitemap is a cached page, rebuilt at most once per
// revalidation, never once per crawl.
const anonymous = async () => new Headers();
const privateRead: BackendPageReadDependencies = { origin: SITE_ORIGIN, headers: anonymous, relay: backendPrivateServerRead };

async function json<Result>(path: string): Promise<Result> {
  const response = await readPrivateBackendPage(path, privateRead);
  if (!response.ok) throw new Error("Sitemap read unavailable.");
  return await response.json() as Result;
}

const settled = <Value,>(result: PromiseSettledResult<readonly Value[]>): readonly Value[] =>
  result.status === "fulfilled" ? result.value : [];

/**
 * The first page of Home's coins, each presale tab and the traders board:
 * 5 backend reads per sitemap rebuild. A sale's coin is listed by its sale page.
 * A failed read leaves its list empty.
 */
export async function readSitemapLists(): Promise<SitemapLists> {
  const presales = presaleBackendPageReads({ headers: anonymous, relay: backendFirstPartyRead, origin: SITE_ORIGIN });
  const [coins, traders, ...presalePages] = await Promise.allSettled([
    json<HomeCoinsPage>(socialHomePath({ limit: HOME_PAGE_MAX })).then((page) => withoutTestCoins(page).coins.flatMap((coin) => coin.presale_id === null ? [coin.coin_type] : [])),
    json<HomeTradersPage>(socialHomeTradersPath(HOME_DEFAULT_WINDOW, { ...HOME_TRADERS_DEFAULT_QUERY, limit: HOME_PAGE_MAX }))
      .then((page) => page.traders.flatMap(({ key }) => key.startsWith("c:") ? [key.slice(2)] : [])),
    ...PRESALE_LIST_STATUSES.map((status) =>
      presales.list({ status, limit: PRESALE_LIST_MAX_LIMIT }).then((page) => page.presales.map((sale) => sale.presale_id))),
  ]);
  return { coinTypes: settled(coins), callsigns: settled(traders), presaleIds: presalePages.flatMap(settled) };
}
