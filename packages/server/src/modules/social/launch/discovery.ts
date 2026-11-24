import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { handleBondingRequest } from "../../launchpad-discovery/bonding.ts";

export type MyBondingLaunchesDependencies = Readonly<{
  kit: SocialRouteKit;
  wallets: (accountId: string) => Promise<readonly string[]>;
  commitment: (accountId: string) => Promise<Uint8Array | null>;
  market?: MarketDataDependencies;
}>;

/** An account commitment proves attribution. Launcher only selects the originating wallet bucket;
 * it never stands in for creator authority. The read never mints or exposes a commitment. */
export function createMyBondingLaunchesRoute(
  dependencies: MyBondingLaunchesDependencies,
) {
  return dependencies.kit.route(
    {
      name: "GET /api/social/me/launches/discovery",
      auth: "account",
      account: "required",
      bucket: "social_read",
      cache: "private",
    },
    async (context) => {
      const url = new URL(context.request.url);
      const keys = [...url.searchParams.keys()];
      if (
        new Set(keys).size !== keys.length ||
        keys.some((key) => !["wallet", "q", "limit", "cursor"].includes(key))
      )
        throw new SocialRouteError("invalid_request");
      const raw = url.searchParams.get("wallet");
      if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw))
        throw new SocialRouteError("invalid_request");
      const wallet = normalizeSuiAddress(raw);
      const accountId = context.account!.account_id;
      const wallets = await dependencies.wallets(accountId);
      if (!wallets.some((address) => normalizeSuiAddress(address) === wallet))
        throw new SocialRouteError("not_creator_recipient");
      const commitment = await dependencies.commitment(accountId);
      url.searchParams.delete("wallet");
      const request = new Request(url, context.request);
      const response = await handleBondingRequest(
        request,
        dependencies.market,
        wallet,
        commitment ? Buffer.from(commitment).toString("hex") : undefined,
      );
      return context.request.method === "HEAD"
        ? new Response(null, {
            status: response.status,
            headers: response.headers,
          })
        : response;
    },
  );
}
