import type { SuiGrpcClient } from "@mysten/sui/grpc";

import type { CoinMetadata, CoinMetadataSource } from "@blast/server/modules/presale/receipts/routes.ts";

/**
 * A coin's `Currency` metadata from the node's state service. Unlike the
 * client's `core.getCoinMetadata`, a failing or unreachable node throws (the
 * route answers `service_unavailable`) instead of reading as "no metadata".
 */
export function grpcCoinMetadataSource(client: Pick<SuiGrpcClient, "stateService">): CoinMetadataSource {
  return async (coinType, signal): Promise<CoinMetadata | null> => {
    const { response } = await client.stateService.getCoinInfo({ coinType }, { abort: signal });
    const metadata = response.metadata;
    if (!metadata) return null;
    return {
      name: metadata.name ?? "",
      symbol: metadata.symbol ?? "",
      decimals: metadata.decimals ?? 0,
      iconUrl: metadata.iconUrl || null,
    };
  };
}
