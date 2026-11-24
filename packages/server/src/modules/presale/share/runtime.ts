import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { routeParams } from "@blast/core/modules/backend-api/route-path.ts";
import { PRESALE_SHARE_IMAGE_PATH } from "@blast/core/modules/backend-api/private/share-images-contracts.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { isSocialEnabled } from "@blast/core/lib/social-flag.ts";
import { socialPresalePath, type SocialPresaleDetail } from "@blast/core/modules/social/contracts/presales.ts";
import { anonymousPartnerHeaders } from "@blast/server/modules/partner-api/v1/response.ts";
import { socialPresaleRoutes } from "@blast/server/modules/social/presales/shared-runtime.ts";
import { cachedCoinLogo, fetchCoinLogo } from "@blast/server/modules/presale/receipts/logo.ts";
import { trackRequestWork } from "@blast/server/lib/request-work.ts";
import { createPresaleShareImageRoute } from "./route.ts";
import { renderShareImage } from "@blast/server/modules/share-images/renderer.ts";

/** Invoke the existing uncached anonymous owner, with its one original IP admission. */
export async function readSharePresale(request: Request, id: string, read: (request: Request, client: ClientAddress) => Promise<Response>, client: ClientAddress): Promise<SocialPresaleDetail["presale"] | null> {
  const headers = anonymousPartnerHeaders(request);
  headers.delete("origin");
  const response = await read(new Request(new URL(socialPresalePath(id), request.url), { headers, signal: request.signal }), client);
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) return null;
    throw new Error("Presale share read unavailable");
  }
  return ((await response.json()) as SocialPresaleDetail).presale;
}

export function createPresaleShareHandler(dependencies: Readonly<{
  image: (request: Request, id: string, client: ClientAddress) => Promise<Response>;
  socialEnabled: () => boolean;
}>) {
  return async (request: Request, client: ClientAddress): Promise<Response> => {
    if (!dependencies.socialEnabled()) return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
    // An undecodable path is "" and the image owner answers it.
    const id = routeParams(PRESALE_SHARE_IMAGE_PATH, new URL(request.url).pathname)?.presaleId ?? "";
    return dependencies.image(request, id, client);
  };
}

export function presaleShareRoute(): (request: Request, client: ClientAddress) => Promise<Response> {
  return processSingleton("presale.share-image", () => {
    const image = createPresaleShareImageRoute({
      readSale: (id, request, client) => readSharePresale(request, id, (inner, innerClient) => socialPresaleRoutes().presale.GET(inner, innerClient), client),
      logo: cachedCoinLogo((url) => fetchCoinLogo(url, { trackWork: trackRequestWork }), { maxBytes: 4 * 1024 * 1024 }),
      cover: cachedCoinLogo((url) => fetchCoinLogo(url, { fit: "inside", trackWork: trackRequestWork }), { maxBytes: 4 * 1024 * 1024 }),
      render: (sale, artwork) => renderShareImage({ kind: "presale", sale, artwork }),
    });
    return createPresaleShareHandler({ image, socialEnabled: isSocialEnabled });
  });
}
