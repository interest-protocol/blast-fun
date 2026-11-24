import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "#web/lib/site.ts";

// Cached like the sitemap (which reads the launchpad and presale flags when it
// renders), so both take the site origin from the same environment.
export const revalidate = 3600;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN,
  };
}
