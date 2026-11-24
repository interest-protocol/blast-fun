import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "#web/lib/site.ts";

// Cache robots.txt and the sitemap for the same hour.
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
