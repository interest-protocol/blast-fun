import { routeParams } from "@blast/core/modules/backend-api/route-path.ts";
import { COIN_PAGE_PATH, COIN_PAGE_RESOLVE_PRESALE } from "@blast/core/modules/backend-api/private/coin-page-contracts.ts";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { CoinPageTransfer, CoinTypePageTransfer, PresalePageAlias } from "@blast/core/modules/launchpad-coin/transfer.ts";
import { coinCreatorAddress } from "@blast/core/modules/launchpad-coin/contracts.ts";
import { encodeCoinWire } from "@blast/core/modules/launchpad-coin/wire.ts";
import { parseCoinPageKey } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { readCoinTypeIdentity, readPresalePageAlias } from "@blast/server/modules/launchpad-coin/resolve.ts";
import { settledAll } from "@blast/server/lib/settled-all.ts";
import { readLaunchDetails } from "@blast/server/modules/social/launch/details.ts";
import { readLaunchVerifiedTeam } from "@blast/server/modules/social/read-model/verified-team.ts";
import { readCoinPage } from "@blast/server/modules/launchpad-coin/read.ts";
import { coinCreatorName, coinPageDependencies, coinPageExplorer } from "@blast/server/modules/launchpad-coin/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export function coinPageReadHandler(dependencies: {
  read: typeof readCoinPage;
  resolve?: typeof readCoinTypeIdentity;
  presaleExists?: typeof readPresalePageAlias;
  configured: typeof coinPageDependencies;
  explorer: typeof coinPageExplorer;
  details?: typeof readLaunchDetails;
  verified?: typeof readLaunchVerifiedTeam;
  creatorName?: typeof coinCreatorName;
} = {
  read: readCoinPage,
  presaleExists: readPresalePageAlias,
  configured: coinPageDependencies,
  explorer: coinPageExplorer,
  details: readLaunchDetails,
  verified: readLaunchVerifiedTeam,
  creatorName: coinCreatorName,
}) {
  async function launch(launchId: string): Promise<CoinPageTransfer> {
    const configured = await dependencies.configured();
    const readWithCreator = dependencies.read(launchId, configured).then(async (read) => {
      if (read.kind !== "coin") return read;
      const creator = coinCreatorAddress(read.page);
      const creatorName = creator ? await dependencies.creatorName?.(creator).catch(() => null) : null;
      return creatorName ? { ...read, page: { ...read.page, creatorName } } : read;
    });
    const [read, explorer, details, verified] = await settledAll([
      readWithCreator, dependencies.explorer(),
      dependencies.details?.(launchId).catch(() => null) ?? Promise.resolve(null),
      // The mark is extra: a failed probe shows the page without it.
      dependencies.verified?.(launchId).catch(() => false) ?? Promise.resolve(false),
    ]);
    return {
      read, explorer, details, ...(verified ? { verifiedTeam: true as const } : {}),
      browserMarket: configured.market ? { expected: configured.market.expected } : null,
    };
  }

  function send(transfer: CoinPageTransfer | CoinTypePageTransfer | PresalePageAlias) {
    return new Response(encodeCoinWire(transfer), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  }

  async function readObject(launchId: string, resolvePresale: boolean): Promise<Response> {
    const transfer = await launch(launchId);
    const confirmed = transfer.read.kind === "coin" && transfer.read.page.confirmed;
    if (!resolvePresale || confirmed) {
      return send(transfer);
    }

    try {
      if (await dependencies.presaleExists?.(launchId)) {
        return send({ kind: "presale", presaleId: launchId });
      }
    } catch {
      recordMetric("launchpad.presale_alias", { outcome: "unavailable" });
      // A failed sale read cannot establish that a non-launch ID is missing.
      if (transfer.read.kind === "not-found") {
        return Response.json({ error: { code: "service_unavailable" } }, {
          status: 503,
          headers: { "Cache-Control": "private, no-store" },
        });
      }
    }
    return send(transfer);
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const key = parseCoinPageKey(routeParams(COIN_PAGE_PATH, url.pathname)?.coinType ?? "");
    if (!key) return Response.json({ error: { code: "invalid_launch_id" } }, { status: 400 });
    if (key.kind === "launch-id") {
      return readObject(key.launchId, url.searchParams.get(COIN_PAGE_RESOLVE_PRESALE) === "1");
    }

    const identity = await (dependencies.resolve ?? readCoinTypeIdentity)(key.coinType);
    return send(identity.kind === "launch" ? { ...identity, transfer: await launch(identity.launchId) } : identity);
  };
}
const read = coinPageReadHandler();
export const COIN_PAGE_HANDLERS = {
  "launchpad.coin-page.read": (request) => read(request),
} satisfies PrivateHandlers;
