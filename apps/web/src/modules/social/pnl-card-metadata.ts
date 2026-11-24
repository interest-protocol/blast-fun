import type { Metadata } from "next";
import { SITE_ORIGIN } from "#web/lib/site.ts";
import { pnlCardSharePath } from "@blast/core/modules/social/contracts/pnl-card-sharing.ts";

export function pnlCardShareMetadata(id: string, callsign?: string): Metadata {
  const url = new URL(pnlCardSharePath(id, callsign), SITE_ORIGIN).href;
  const image = new URL(`${pnlCardSharePath(id)}/image`, SITE_ORIGIN).href;
  const title = "My Blast PnL";
  const description = "A PnL since launch card shared from Blast.";
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index: false, follow: false },
    openGraph: {
      type: "website",
      title,
      description,
      url,
      images: [{ url: image, width: 1200, height: 675, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}
