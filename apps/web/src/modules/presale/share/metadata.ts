import type { Metadata } from "next";
import { presaleShareRevision } from "@blast/core/modules/presale/share/revision.ts";

import { SITE_ORIGIN } from "#web/lib/site.ts";
import type { SocialPresaleSummary } from "@blast/core/modules/social/contracts/presales.ts";

export function presaleShareUrl(presaleId: string): string {
  return new URL(`/presale/${encodeURIComponent(presaleId)}`, SITE_ORIGIN).href;
}

export function presalePreviewUrl(sale: SocialPresaleSummary): string {
  const url = new URL(presaleShareUrl(sale.presale_id));
  url.searchParams.set("share", presaleShareRevision(sale));
  return url.href;
}

export function presaleXIntent(sale: SocialPresaleSummary): string {
  const intent = new URL("https://x.com/intent/post");
  intent.searchParams.set("url", presalePreviewUrl(sale));
  return intent.href;
}

export function presaleShareMetadata(sale: SocialPresaleSummary): Metadata {
  const title = `${sale.name} ($${sale.symbol.replace(/^\$+/, "")}) · Blast`;
  const description = sale.metadata?.tagline || `Explore ${sale.name}'s presale on Blast.`;
  const url = presaleShareUrl(sale.presale_id);
  const image = `${url}/share-image?v=${presaleShareRevision(sale)}`;
  const alt = `${sale.name} presale on Blast`;

  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website", title, description, url: presalePreviewUrl(sale),
      images: [{ url: image, width: 1200, height: 675, type: "image/png", alt }],
    },
    twitter: {
      card: "summary_large_image", title, description, site: "@blastdotfun",
      images: [{ url: image, alt }],
    },
  };
}
