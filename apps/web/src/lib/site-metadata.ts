import type { Metadata, Viewport } from "next";

import { LANDING_BRAND, SITE_NAME, SITE_ORIGIN } from "./site.ts";

export function siteMetadata(socialUrl = SITE_ORIGIN): Metadata {
  return {
    metadataBase: new URL(SITE_ORIGIN),
    title: {
      default: LANDING_BRAND.title,
      template: `%s | ${SITE_NAME}`,
    },
    description: LANDING_BRAND.description,
    applicationName: SITE_NAME,
    authors: [{ name: SITE_NAME, url: SITE_ORIGIN }],
    creator: SITE_NAME,
    publisher: SITE_NAME,
    keywords: [
      "BLAST.FUN",
      "Blast",
      "Sui",
      "meme coin launchpad",
      "meme coins",
      "crypto launchpad",
      "Sui wallet",
    ],
    alternates: {
      canonical: "/",
    },
    category: "finance",
    formatDetection: {
      telephone: false,
      email: false,
      address: false,
    },
    openGraph: {
      title: LANDING_BRAND.title,
      description: LANDING_BRAND.description,
      url: socialUrl,
      siteName: SITE_NAME,
      locale: "en_US",
      type: "website",
      images: [
        {
          url: LANDING_BRAND.socialImageUrl,
          secureUrl: LANDING_BRAND.socialImageUrl,
          width: 1200,
          height: 630,
          type: "image/png",
          alt: LANDING_BRAND.socialImageAlt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: LANDING_BRAND.title,
      description: LANDING_BRAND.description,
      site: "@blastdotfun",
      creator: "@blastdotfun",
      images: [
        {
          url: LANDING_BRAND.socialImageUrl,
          alt: LANDING_BRAND.socialImageAlt,
        },
      ],
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
  };
}

export function siteViewport(): Viewport {
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: LANDING_BRAND.themeColor,
  };
}
