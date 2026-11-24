import type { MetadataRoute } from "next";
import { launchFlagsFor } from "@blast/core/lib/launch-flags.ts";
import { sitemapEntries } from "#web/lib/sitemap-entries.ts";

// Keep sitemap and robots.txt cached for the same hour.
export const revalidate = 3600;

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapEntries(launchFlagsFor().launchpad);
}
