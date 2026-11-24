import { normalizeSiteOrigin } from "@blast/core/lib/site-origin.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export function siteOrigin(environment: Environment = process.env): string {
  return normalizeSiteOrigin(environment.NEXT_PUBLIC_SITE_URL);
}
