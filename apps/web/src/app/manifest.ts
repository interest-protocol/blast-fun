import type { MetadataRoute } from "next";
import { INSTALLED_THEME_COLOR } from "#web/lib/site-theme-colors.generated.ts";
import { SITE_NAME, LANDING_BRAND } from "#web/lib/site.ts";

// The installed app starts at `/`, the public launchpad, in every Mission
// Control flag state.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME} — Meme Coin Launchpad`,
    short_name: SITE_NAME,
    description: LANDING_BRAND.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: INSTALLED_THEME_COLOR,
    theme_color: INSTALLED_THEME_COLOR,
    categories: ["finance", "entertainment"],
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
