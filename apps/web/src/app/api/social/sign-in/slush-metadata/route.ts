import { SLUSH_WALLET_ICON, SLUSH_WALLET_NAME } from "@mysten/slush-wallet";

export const dynamic = "force-static";

/**
 * The Slush web wallet's metadata, served from this origin: dApp Kit fetches
 * it when it registers Slush, and the site's CSP (`connect-src`) does not
 * allow `api.slush.app`. The same answer as Mission Control's route, under
 * the social namespace so it exists whenever the social feed is on.
 */
export function GET(): Response {
  return Response.json(
    { enabled: true, icon: SLUSH_WALLET_ICON, id: "com.mystenlabs.suiwallet.web", walletName: SLUSH_WALLET_NAME },
    { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } },
  );
}
