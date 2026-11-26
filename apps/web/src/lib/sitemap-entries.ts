import type { MetadataRoute } from "next";

import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { profilePagePath } from "@blast/core/modules/social/contracts/profiles.ts";
import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";

import { LANDING_BRAND, SITE_ORIGIN } from "./site.ts";

/** The public pages the sitemap lists beside the fixed ones. */
export type SitemapLists = Readonly<{
  coinTypes: readonly string[];
  presaleIds: readonly string[];
  callsigns: readonly string[];
}>;

const NO_LISTS: SitemapLists = { coinTypes: [], presaleIds: [], callsigns: [] };

export function sitemapEntries(lists: SitemapLists = NO_LISTS): MetadataRoute.Sitemap {
  const page = (path: string) => ({ url: `${SITE_ORIGIN}${path}`, changeFrequency: "daily" as const, priority: 0.6 });
  return [
    { url: SITE_ORIGIN, changeFrequency: "weekly", priority: 1, images: [LANDING_BRAND.socialImageUrl] },
    ...[...new Set(lists.coinTypes)].map((coinType) => page(coinPagePath(coinType))),
    ...[...new Set(lists.presaleIds)].map((presaleId) => page(presalePath(presaleId))),
    ...[...new Set(lists.callsigns)].map((callsign) => page(profilePagePath(callsign))),
    { url: `${SITE_ORIGIN}/privacy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${SITE_ORIGIN}/terms`, changeFrequency: "yearly", priority: 0.2 },
  ];
}
