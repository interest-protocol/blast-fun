import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { COIN_TYPE } from "@blast/core/lib/sui/ids.ts";
import { routeParams } from "@blast/core/modules/backend-api/route-path.ts";
import { replicaPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { httpsProjectUrl, poolCoinMetadata } from "@blast/core/modules/launchpad-coin/pool-coin-metadata.ts";
import { wireIconUrl, wireText } from "@blast/core/modules/social/contracts/financial-wire.ts";
import { PUBLIC_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { normalizeSaleLink, normalizeTelegram, normalizeXHandle } from "@blast/core/modules/social/sales/validate.ts";
import { publicReadCache } from "@blast/server/modules/public-reads/shared-runtime.ts";
import { readLaunchDetails } from "@blast/server/modules/social/launch/details.ts";
import { PARTNER_COIN_METADATA_PATH } from "./paths.ts";

export async function handleCoinMetadataRequest(
  request: Request,
  read = readCachedCoinMetadata,
): Promise<Response> {
  const url = new URL(request.url);
  const coinType = routeParams(PARTNER_COIN_METADATA_PATH, url.pathname)?.coinType;
  if (!coinType || !COIN_TYPE.test(coinType) || url.search) {
    return publicErrorResponse("invalid_parameter", "Supply a canonical coin type and no query parameters.", 400);
  }

  try {
    const metadata = await read(coinType);
    if (!metadata) {
      return publicErrorResponse("not_found", "Coin not found.", 404);
    }
    return Response.json(metadata);
  } catch (cause) {
    return publicErrorResponse("unavailable", "Coin metadata is temporarily unavailable.", 503, { cause });
  }
}

function readCachedCoinMetadata(coinType: string) {
  return publicReadCache("market")(
    `partner-coin-metadata:v1:${coinType}`,
    () => readCoinMetadata(autocommitReader(replicaPool(), "social", { label: "partner.coin_metadata" }), coinType),
    10_000,
  );
}

type CoinMetadataRow = {
  launch_id: string | null;
  name: string | null;
  symbol: string | null;
  description: string | null;
  decimals: number | null;
  icon_url: string | null;
  tagline: string | null;
  site: string | null;
  x_handle: string | null;
  telegram: string | null;
  docs_url: string | null;
  audit_url: string | null;
};

export async function readCoinMetadata(
  db: ReadableDatabase,
  coinType: string,
  readPublishedLaunch: typeof readLaunchDetails = readLaunchDetails,
) {
  const { rows: [row] } = await db.read<CoinMetadataRow>(`
    SELECT curve.pool_id AS launch_id,
           COALESCE(m.name, presale.sale_name) AS name,
           COALESCE(m.symbol, presale.sale_symbol) AS symbol,
           m.description, COALESCE(m.decimals, presale.sale_decimals)::int AS decimals,
           COALESCE(m.icon_url, presale.sale_icon_url) AS icon_url,
           s.tagline, s.site, s.x_handle, s.telegram, s.docs_url, s.audit_url
    FROM (SELECT $1::text AS coin_type) requested
    LEFT JOIN chain_read_v1.coin_metadata m ON m.coin_type = requested.coin_type
    LEFT JOIN LATERAL (
      SELECT presale_id, sale_name, sale_symbol, sale_decimals, sale_icon_url FROM ${PUBLIC_PRESALES} p
      WHERE p.sale_token = requested.coin_type
      ORDER BY p.presale_id LIMIT 1
    ) presale ON TRUE
    LEFT JOIN social_sale_metadata s ON s.presale_id = presale.presale_id
    LEFT JOIN LATERAL (
      SELECT pool_id FROM chain_read_v1.pools
      WHERE venue = 'blast_curve' AND coin_type = requested.coin_type AND presale.presale_id IS NULL
      ORDER BY pool_id LIMIT 1
    ) curve ON TRUE
    WHERE m.coin_type IS NOT NULL OR presale.presale_id IS NOT NULL OR curve.pool_id IS NOT NULL`, [coinType]);
  if (!row) {
    return null;
  }

  // Use the coin page's published-details reader only for a confirmed Blast curve.
  const launch = row.launch_id ? await readPublishedLaunch(row.launch_id) : null;
  const chain = poolCoinMetadata(row.description ?? undefined);
  const links = [...(launch?.links ?? []), ...chain.links];
  const projectLink = (label: string) => wireIconUrl(links.find((link) => link.label === label)?.url);
  const website = normalizeSaleLink(row.site ?? "");
  const x = normalizeXHandle(row.x_handle ?? "");
  const telegram = normalizeTelegram(row.telegram ?? "");
  const docs = normalizeSaleLink(row.docs_url ?? "");
  const audit = normalizeSaleLink(row.audit_url ?? "");

  return {
    coin_type: coinType,
    name: wireText(row.name, 128),
    symbol: wireText(row.symbol, 64),
    description: wireText(chain.description, 1_024),
    decimals: row.decimals,
    icon_url: httpsProjectUrl(wireIconUrl(launch?.iconUrl ?? row.icon_url)),
    tagline: wireText(launch?.tagline ?? row.tagline, 160),
    links: {
      website: (website.ok && website.value) || projectLink("Website"),
      x: x.ok && x.value ? `https://x.com/${x.value}` : projectLink("X"),
      telegram: telegram.ok && telegram.value ? `https://t.me/${telegram.value}` : projectLink("Telegram"),
      docs: (docs.ok && docs.value) || projectLink("Docs"),
      audit: (audit.ok && audit.value) || projectLink("Audit"),
    },
  };
}
