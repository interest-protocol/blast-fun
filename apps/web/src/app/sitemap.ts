import type { MetadataRoute } from "next";
import { readSitemapLists } from "#web/lib/backend-api/sitemap-lists.ts";
import { sitemapEntries } from "#web/lib/sitemap-entries.ts";

// Keep sitemap and robots.txt cached for the same hour.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapEntries(await readSitemapLists());
}
