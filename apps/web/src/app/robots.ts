import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "#web/lib/site.ts";

// Cache robots.txt and the sitemap for the same hour.
export const revalidate = 3600;

export default function robots(): MetadataRoute.Robots {
  // dev.blast.fun (Vercel custom environment `dev`) tests risky branches: keep it out of search.
  if (process.env.VERCEL_TARGET_ENV === "dev") return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN,
  };
}
