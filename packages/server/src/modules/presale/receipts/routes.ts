import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { PRESALE_RECEIPT_IMAGE_PATH } from "@blast/core/modules/backend-api/private/presale-receipt-contracts.ts";
import { settledAll } from "@blast/server/lib/settled-all.ts";
import {
  createPresaleReceiptRecord,
  RECEIPT_NAME_MAX,
  RECEIPT_SYMBOL_MAX,
  receiptDisplayText,
} from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import {
  CARD_IMAGE_RETRY_AFTER_SECONDS,
  CardImageBusyError,
  type CardImageFormat,
  type PresaleReceiptImage,
} from "@blast/core/modules/mission-control/card-images/contracts.ts";
import { cardImageBody } from "@blast/server/modules/mission-control/card-images/route.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import type { PresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import type { CoinLogoOutcome } from "@blast/server/modules/presale/receipts/logo.ts";
import { amountCommitted, type PresaleReadPath } from "@blast/server/modules/presale/receipts/read-path.ts";

/** A coin's `Currency` metadata as the node reports it; null when the coin has none. */
export type CoinMetadata = Readonly<{ name: string; symbol: string; decimals: number; iconUrl: string | null }>;
export type CoinMetadataSource = (coinType: string, signal?: AbortSignal) => Promise<CoinMetadata | null>;

export type PresaleReceiptDependencies = Readonly<{
  kit: PresaleRouteKit;
  /** blast-infra's presale `/v1` reads. */
  readPath: PresaleReadPath;
  /** The coins' on-chain `Currency` metadata. */
  metadata: CoinMetadataSource;
  /** The wallet's crew number, or null. */
  crew: (wallet: string) => Promise<number | null>;
  /** The guarded logo fetch: never throws; a null logo says whether its refusal was transient. */
  logo: (url: string | null) => Promise<CoinLogoOutcome>;
  images: Readonly<{ receiptImage(input: Readonly<{ format: CardImageFormat; record: unknown }>): Promise<PresaleReceiptImage> }>;
}>;

/** While the sale is open the amount can still grow. */
export const PRESALE_RECEIPT_OPEN_CACHE_CONTROL = "public, max-age=30, s-maxage=60";
/**
 * After it the commitment is final, so the image is too, unless the logo
 * fell back because of a transient failure: then the short policy applies, so
 * caches pick up the real logo soon.
 */
export const PRESALE_RECEIPT_CLOSED_CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";

const HEX_ID = /^0x[0-9a-fA-F]{64}$/;
/** The route's formats and the image service's: `post` is the 1200 x 675 share layout. */
const FORMATS: Readonly<Record<string, CardImageFormat>> = { card: "card", post: "share" };

/** `{presale_id}`, `{wallet}` and `?format=card|post`; anything else is `invalid_parameter` (CL-21). */
function parameters(request: Request): Readonly<{ presaleId: string; wallet: string; format: CardImageFormat }> {
  const url = new URL(request.url);
  const path = routeSegments(PRESALE_RECEIPT_IMAGE_PATH, url.pathname);
  const formats = url.searchParams.getAll("format");
  const format = formats.length === 1 ? FORMATS[formats[0]] : undefined;
  if (!path || !HEX_ID.test(path.presale_id) || !HEX_ID.test(path.wallet) || !format || !Object.hasOwn(FORMATS, formats[0])) {
    throw new PresaleRouteError("invalid_parameter");
  }
  return { presaleId: path.presale_id.toLowerCase(), wallet: path.wallet.toLowerCase(), format };
}

/** The coin's metadata; a coin without any, like a failing node, is `service_unavailable`. */
async function coinMetadata(source: CoinMetadataSource, coinType: string, signal: AbortSignal): Promise<CoinMetadata> {
  const metadata = await source(coinType, signal);
  if (!metadata || !Number.isInteger(metadata.decimals)) throw new PresaleRouteError("service_unavailable");
  return metadata;
}

/** The coin's display text, or its type's struct name when the metadata leaves it blank. */
function display(value: string, coinType: string, max: number): string {
  return receiptDisplayText(value, max) || receiptDisplayText(coinType.split("::")[2]?.replace(/<.*$/, "") ?? "", max) || "?";
}

/**
 * `GET /api/presale/receipts/{presale_id}/{wallet}/image?format=card|post`
 * (contract 3.4, CL-9): the wallet's commitment receipt as a PNG. Public, in
 * the `presale_receipt` bucket per client IP. It reads the wallet's commits
 * and the sale from blast-infra, the coins' `Currency` metadata from the node,
 * the wallet's crew, and the sale coin's logo through the fetch guard, then
 * renders through the card image service, which caches by record digest.
 * Errors are the kit's JSON bodies: `invalid_parameter`, `not_found` for a
 * wallet without a commit or an unknown sale, and `service_unavailable` with
 * `Retry-After` when blast-infra, the node or the database is unavailable or
 * the renderer is busy.
 */
export function createPresaleReceiptRoute(dependencies: PresaleReceiptDependencies): (request: Request, client: ClientAddress) => Promise<Response> {
  const { kit, readPath, metadata, crew, logo, images } = dependencies;
  return kit.route(
    { name: "GET /api/presale/receipts/{presale_id}/{wallet}/image", auth: "none", bucket: "presale_receipt" },
    async (context) => {
      const { presaleId, wallet, format } = parameters(context.request);
      const signal = context.request.signal;
      const amount = amountCommitted(await readPath.commits(presaleId, wallet, signal));
      if (amount === null) throw new PresaleRouteError("not_found");
      const sale = await readPath.sale(presaleId, signal);
      const [coin, quote, crewNumber] = await settledAll([
        coinMetadata(metadata, sale.saleToken, signal),
        coinMetadata(metadata, sale.quote, signal),
        crew(wallet),
      ]);
      const logoOutcome = await logo(coin.iconUrl);
      const record = createPresaleReceiptRecord({
        schema: "blast.presale-receipt",
        version: 1,
        presaleId,
        wallet,
        saleToken: sale.saleToken,
        quote: sale.quote,
        amountCommitted: amount,
        quoteSymbol: display(quote.symbol, sale.quote, RECEIPT_SYMBOL_MAX),
        quoteDecimals: quote.decimals,
        coinName: display(coin.name, sale.saleToken, RECEIPT_NAME_MAX),
        coinSymbol: display(coin.symbol, sale.saleToken, RECEIPT_SYMBOL_MAX),
        logo: logoOutcome.logo,
        crew: crewNumber,
      });
      let image: PresaleReceiptImage;
      try {
        image = await images.receiptImage({ format, record });
      } catch (error) {
        if (error instanceof CardImageBusyError) {
          throw new PresaleRouteError("service_unavailable", { retryAfterSeconds: CARD_IMAGE_RETRY_AFTER_SECONDS });
        }
        throw error;
      }
      return new Response(cardImageBody(image.bytes), {
        headers: {
          "Cache-Control":
            sale.lifecycle === "open" || (!logoOutcome.logo && logoOutcome.transient)
              ? PRESALE_RECEIPT_OPEN_CACHE_CONTROL
              : PRESALE_RECEIPT_CLOSED_CACHE_CONTROL,
          "Content-Length": String(image.bytes.byteLength),
          "Content-Type": image.contentType,
          "X-Request-ID": context.requestId,
        },
      });
    },
  );
}
