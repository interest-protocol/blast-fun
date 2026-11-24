import { publicJson } from "@blast/core/lib/http-errors.ts";
import { SLUSH_WALLET_ICON, SLUSH_WALLET_NAME } from "@mysten/slush-wallet";

export const dynamic = "force-static";

export function GET(): Response {
  return publicJson(
    {
      enabled: true,
      icon: SLUSH_WALLET_ICON,
      id: "com.mystenlabs.suiwallet.web",
      walletName: SLUSH_WALLET_NAME,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    },
  );
}
