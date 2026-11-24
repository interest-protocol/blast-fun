import type { MetadataRoute } from "next";

import { LANDING_BRAND, SITE_ORIGIN } from "./site.ts";

/** The public sitemap includes /launch when the launchpad is enabled. */
export function sitemapEntries(launchpadEnabled: boolean): MetadataRoute.Sitemap {
  return [
    { url: SITE_ORIGIN, changeFrequency: "weekly" as const, priority: 1, images: [LANDING_BRAND.socialImageUrl] },
    ...(launchpadEnabled
      ? [{ url: `${SITE_ORIGIN}/launch`, changeFrequency: "weekly" as const, priority: 0.8 }]
      : []),
    { url: `${SITE_ORIGIN}/privacy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${SITE_ORIGIN}/terms`, changeFrequency: "yearly", priority: 0.2 },
  ];
}
