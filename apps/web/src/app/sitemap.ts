import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { readSitemapLists } from "#web/lib/backend-api/sitemap-lists.ts";
import { sitemapEntries } from "#web/lib/sitemap-entries.ts";

// The backend signs the caller's platform address, so the sitemap renders per
// request; its lists are cached for an hour in readSitemapLists.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapEntries(await readSitemapLists((await headers()).get("x-vercel-forwarded-for")));
}
