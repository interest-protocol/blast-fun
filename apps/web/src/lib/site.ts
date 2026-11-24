import { normalizeSiteOrigin } from "@blast/core/lib/site-origin.ts";

import { LANDING_THEME_COLOR } from "./site-theme-colors.generated.ts";

// A literal `process.env.NEXT_PUBLIC_*` read: Next inlines it into client and server bundles alike.
export const SITE_ORIGIN = normalizeSiteOrigin(process.env.NEXT_PUBLIC_SITE_URL);

export const SITE_NAME = "BLAST.FUN";
export const SITE_X_URL = "https://x.com/blastdotfun";
export const SITE_X_FOLLOW_URL = "https://x.com/intent/follow?user_id=1946307922717179904";
export const SITE_TELEGRAM_URL = "https://t.me/blastdofun";
export const SITE_MAP_URL = "https://map.blast.fun/";
export const SITE_DOCS_URL = "https://docs.blast.fun/";
// X and Telegram cache failed preview-image fetches independently of the page.
// Bump this value whenever the social card changes or a stale crawler cache must be retired.
const SITE_SOCIAL_IMAGE_VERSION = "20260925";

export const SITE_SOCIAL_IMAGE_URL = `${SITE_ORIGIN}/landing/social-card.png?v=${SITE_SOCIAL_IMAGE_VERSION}`;
export const SITE_SOCIAL_IMAGE_ALT =
  "Blast logo and saluting pink-helmeted mascot on a dark teal and pink gradient.";
export const SITE_SOCIAL_SHARE_URL = `${SITE_ORIGIN}/launch`;

export const LANDING_BRAND = {
  title: "BLAST.FUN | Meme Coin Launchpad on Sui",
  description: "Blast is the meme coin launchpad on Sui. Ready for liftoff.",
  socialImageUrl: SITE_SOCIAL_IMAGE_URL,
  socialImageAlt: SITE_SOCIAL_IMAGE_ALT,
  themeColor: LANDING_THEME_COLOR,
};
