import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { LANDING_BRAND, SITE_NAME, SITE_ORIGIN, SITE_X_URL } from "#web/lib/site.ts";
import { siteMetadata, siteViewport } from "#web/lib/site-metadata.ts";
import { SiteAnalytics } from "#web/components/analytics/SiteAnalytics.tsx";
import { GateAwareFetch } from "#web/components/api-gate/GateAwareFetch.tsx";
import { DisclosureMotion } from "#web/components/blast-ui/DisclosureMotion.tsx";
import "@fontsource/reenie-beanie/400.css";
import "@fontsource/inter/800.css";
import "@fontsource/patrick-hand/400.css";
import "@fontsource/vt323/400.css";
import "./globals.css";
import "#web/components/blast-ui/blast-ui.css";

export const metadata: Metadata = siteMetadata();

export const viewport: Viewport = siteViewport();

function structuredData() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE_ORIGIN}/#organization`,
        name: SITE_NAME,
        url: SITE_ORIGIN,
        logo: {
          "@type": "ImageObject",
          url: `${SITE_ORIGIN}/icon-512.png`,
          width: 512,
          height: 512,
        },
        sameAs: [SITE_X_URL],
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_ORIGIN}/#website`,
        url: SITE_ORIGIN,
        name: SITE_NAME,
        description: LANDING_BRAND.description,
        publisher: {
          "@id": `${SITE_ORIGIN}/#organization`,
        },
        inLanguage: "en",
      },
    ],
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // A request-bound CSP nonce is required for Next's framework and inline scripts.
  // The legal pages opt out with `dynamic = "force-static"` (their segment
  // layouts), under which this resolves without making them dynamic, so the
  // CDN serves them; the proxy gives them the nonce-free CSP.
  await connection();
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <GateAwareFetch />
        <DisclosureMotion />
        {children}
        <SiteAnalytics />
        <script
          type="application/ld+json"
          nonce={(await headers()).get("x-nonce") ?? undefined}
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structuredData()).replace(
              /</g,
              "\\u003c",
            ),
          }}
        />
      </body>
    </html>
  );
}
