import { RpcError, SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeStructTag } from "@mysten/sui/utils";
import { replicaPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import type { CoinTypePageIdentity } from "@blast/core/modules/launchpad-coin/transfer.ts";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { coinTypeName, wireIconUrl, wireText } from "@blast/core/modules/social/contracts/financial-wire.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { publicReadCache } from "@blast/server/modules/public-reads/shared-runtime.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { presaleExists } from "@blast/server/modules/social/read-model/presale-lookup.ts";

type CoinMetadata = Readonly<{ name: string | null; symbol: string | null; iconUrl: string | null }>;

export async function resolveCoinType(
  coinType: string,
  db: ReadableDatabase,
  nodeMetadata: (coinType: string) => Promise<CoinMetadata | null>,
): Promise<CoinTypePageIdentity> {
  const { rows: [row] } = await db.read<{
    launch_id: string | null;
    presale_id: string | null;
    metadata_coin_type: string | null;
    name: string | null;
    symbol: string | null;
    iconUrl: string | null;
  }>(
    `SELECT curve.pool_id AS launch_id, sale.presale_id, metadata.coin_type AS metadata_coin_type, metadata.name, metadata.symbol,
            CASE WHEN sale.presale_id IS NULL AND curve.pool_id IS NULL AND length(metadata.icon_url) <= 2048
                 THEN metadata.icon_url END AS "iconUrl"
     FROM (SELECT $1::text AS coin_type) requested
     LEFT JOIN LATERAL (
       SELECT presale_id FROM ${SHOWN_PRESALES} p
       WHERE p.sale_token = requested.coin_type
       ORDER BY presale_id LIMIT 1
     ) sale ON TRUE
     LEFT JOIN LATERAL (
       SELECT pool_id FROM chain_read_v1.pools
       WHERE venue = 'blast_curve' AND coin_type = requested.coin_type
       ORDER BY pool_id LIMIT 1
     ) curve ON sale.presale_id IS NULL
     LEFT JOIN chain_read_v1.coin_metadata metadata ON metadata.coin_type = requested.coin_type`,
    [coinType],
  );
  if (!row) throw new Error("Missing coin identity query result");
  if (row.presale_id) return { kind: "presale", coinType, presaleId: row.presale_id };
  if (row.launch_id) return { kind: "launch", coinType, launchId: row.launch_id };
  const curated = coreCoin(coinType);
  const metadata = curated ?? (row.metadata_coin_type ? row : await nodeMetadata(coinType));
  if (!metadata) return { kind: "not-found", coinType };
  const symbol = wireText(metadata.symbol, 64) ?? coinTypeName(coinType, 64);
  const iconUrl = wireIconUrl(row.iconUrl) ?? wireIconUrl("iconUrl" in metadata ? metadata.iconUrl : metadata.logoUrl);
  return { kind: "generic", coinType, name: wireText(metadata.name, 128) ?? symbol, symbol, ...(iconUrl ? { iconUrl } : {}) };
}

export async function readNodeCoinMetadata(
  client: Pick<SuiGrpcClient, "stateService">,
  coinType: string,
): Promise<CoinMetadata | null> {
  try {
    const { response } = await client.stateService.getCoinInfo({ coinType }, { abort: AbortSignal.timeout(3_000) });
    // The state service confirms the coin through its required coinType field.
    // Its metadata can be absent when the metadata object is wrapped.
    if (!response.coinType || normalizeStructTag(response.coinType) !== coinType) {
      throw new Error("Coin info did not match the requested type");
    }
    return {
      name: response.metadata?.name ?? null,
      symbol: response.metadata?.symbol ?? null,
      iconUrl: response.metadata?.iconUrl ?? null,
    };
  } catch (error) {
    if (error instanceof RpcError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

export function readCoinTypeIdentity(coinType: string): Promise<CoinTypePageIdentity> {
  return publicReadCache("market")(`coin-page-identity:${coinType}`, () =>
    resolveCoinType(coinType, autocommitReader(replicaPool(), "social", { label: "launchpad.coin_identity" }), (type) => {
      const node = processSingleton("coin-page.node-metadata", () =>
        new SuiGrpcClient({ network: "mainnet", baseUrl: runtimeConfig().suiNodeUrl, format: "text", fetch: boundedFetch(3_000) }));
      return readNodeCoinMetadata(node, type);
    }), 10_000);
}

export async function readPresalePageAlias(objectId: string): Promise<boolean> {
  return publicReadCache("market")(`coin-page-presale-alias:${objectId}`, () =>
    presaleExists(autocommitReader(replicaPool(), "social", { label: "launchpad.presale_alias" }), objectId),
  10_000);
}
