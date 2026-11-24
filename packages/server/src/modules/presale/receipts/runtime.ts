import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { trackRequestWork } from "@blast/server/lib/request-work.ts";
import { SuiGrpcClient } from "@mysten/sui/grpc";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { missionControlCardImages } from "@blast/server/modules/mission-control/card-images/service.ts";
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { blastInfraFetch } from "@blast/core/modules/read-routing/blast-infra.ts";
import { presaleNodeUrl } from "@blast/core/modules/presale/deployment/node.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { presaleRouteKit } from "@blast/server/modules/presale/route-kit/runtime.ts";
import { PostgresCrewDirectory } from "@blast/server/modules/presale/receipts/crew.ts";
import { cachedCoinLogo, fetchCoinLogo } from "@blast/server/modules/presale/receipts/logo.ts";
import { grpcCoinMetadataSource } from "@blast/server/modules/presale/receipts/metadata.ts";
import { createPresaleReadPath } from "@blast/server/modules/presale/receipts/read-path.ts";
import { createPresaleReceiptRoute, type CoinMetadataSource } from "@blast/server/modules/presale/receipts/routes.ts";

/** The presale identity's node (`PRESALE_SUI_GRPC_URL`, else mainnet's for a mainnet identity), for `Currency` metadata. */
function nodeMetadata(): CoinMetadataSource {
  let source: CoinMetadataSource | undefined;
  return (coinType, signal) => {
    if (!source) {
      const config = runtimeConfig();
      const state = config.presaleDeployment;
      const baseUrl = presaleNodeUrl(state, config.suiNodeUrl);
      if (state.status !== "ready" || !baseUrl) throw new PresaleRouteError("service_unavailable");
      source = grpcCoinMetadataSource(new SuiGrpcClient({ network: state.identity.network, baseUrl, format: "text", fetch: boundedFetch(8_000) }));
    }
    return source(coinType, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(3_000)]));
  };
}

/**
 * The process's receipt image route: the presale kit, blast-infra at
 * `BLAST_INFRA_ORIGIN` (3 s, with its key), the presale identity's node, the
 * primary database for crews, the guarded and cached logo fetch, and the
 * process's one card image service (shared memory cache, render slots, Blob
 * store and catalogs). Settings come from `runtimeConfig()`, parsed at boot.
 */
export function presaleReceiptRoute(): (request: Request, client: ClientAddress) => Promise<Response> {
  return processSingleton("presale.receipt-route", () => {
    const crew = new PostgresCrewDirectory(() => primaryPool());
    let readPath: ReturnType<typeof createPresaleReadPath> | undefined;
    const read = () => {
      if (readPath) return readPath;
      const { infra } = runtimeConfig();
      return (readPath = createPresaleReadPath({ origin: infra.origin, fetch: blastInfraFetch({ infra }), timeoutMs: 3_000 }));
    };
    return createPresaleReceiptRoute({
      kit: presaleRouteKit(),
      readPath: {
        sale: (presaleId, signal) => read().sale(presaleId, signal),
        commits: (presaleId, wallet, signal) => read().commits(presaleId, wallet, signal),
      },
      metadata: nodeMetadata(),
      crew: (wallet) => crew.crewFor(wallet),
      logo: cachedCoinLogo((url) => fetchCoinLogo(url, { trackWork: trackRequestWork })),
      images: { receiptImage: (input) => missionControlCardImages().receiptImage(input) },
    });
  });
}
