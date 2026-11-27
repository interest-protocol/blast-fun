import { cardImageBody } from "@blast/core/modules/mission-control/card-images/body.ts";
import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { LRUCache } from "lru-cache";

import type { PublishedCardSnapshot } from "@blast/core/modules/mission-control/card-images/contracts.ts";
import {
  CARD_IMAGE_RETRY_AFTER_SECONDS,
  publicCardImagePath,
  CardImageBusyError,
  type CardImage,
} from "@blast/core/modules/mission-control/card-images/contracts.ts";
import type { CardImageService } from "@blast/server/modules/mission-control/card-images/service.ts";

/**
 * A published card record never changes. Share URLs additionally carry the
 * current recruit total, and their render digest includes the displayed X
 * handles. The CDN can share a response briefly so retired cards age out,
 * and the browser revalidates.
 */
export const PUBLIC_CARD_IMAGE_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, must-revalidate";

/** About 5 MB of card ids and digests per instance. */
export const PUBLISHED_CARD_DIGEST_ENTRIES = 20_000;

export { publicCardImagePath } from "@blast/core/modules/mission-control/card-images/contracts.ts";

/** The parameters `GET /card/[id]/image` reads from its query. */
export type CardImageQuery = Readonly<{ format: "card" | "share"; recruitTotal: number | undefined }>;

/** `format` (`card`, else the share image) and, for a share image, a whole `recruits` count. */
export function cardImageQuery(search: URLSearchParams): CardImageQuery {
  const format = search.get("format") === "card" ? "card" : "share";
  const recruits = search.get("recruits");
  const recruitTotal = format === "share" && recruits !== null && /^[0-9]{1,9}$/.test(recruits)
    ? Number(recruits)
    : undefined;
  return { format, recruitTotal };
}

/**
 * A 307 to the canonical URL of the image `request` asks for, or null when
 * it already is canonical: the lowercase id, then exactly the query
 * `publicCardImagePath` emits (`format=card` or a share image's `recruits`,
 * and the current renderer's `v`), in that order and encoding. Any other
 * query (an unknown or repeated parameter, another `v`, `format=share`) or
 * an uppercase id is redirected before anything is read, so a random query
 * cannot miss the CDN and reach the database (review M3). Unfurlers fetch
 * the URL the card's page names, which is canonical, so they never see it.
 */
export function canonicalCardImageRedirect(request: Request, cardId: string): Response | null {
  const url = new URL(request.url);
  const query = cardImageQuery(url.searchParams);
  const canonical = publicCardImagePath(cardId, query.format, query.recruitTotal);
  if (`${url.pathname}${url.search}` === canonical) return null;
  return new Response(null, { status: 307, headers: { "Cache-Control": "no-store", Location: canonical } });
}


export interface PublicCardImageDependencies {
  readonly images: Pick<CardImageService, "cached" | "image">;
  /**
   * Card id → record digest for immutable full-card images this instance has
   * served as published. Dynamic share images always read their recruit data.
   * Unknown and unpublished ids are never remembered.
   */
  readonly published: LRUCache<string, string>;
  isPublished(cardId: string): Promise<boolean>;
  publishedCard(cardId: string): Promise<PublishedCardSnapshot | null>;
}

let sharedPublished: LRUCache<string, string> | undefined;

/** The one published-card digest cache per function instance. */
export function missionControlPublishedCardDigests(): LRUCache<string, string> {
  sharedPublished ??= new LRUCache<string, string>({ max: PUBLISHED_CARD_DIGEST_ENTRIES });
  return sharedPublished;
}

function notFound(): Response {
  return publicErrorResponse("CARD_NOT_FOUND", "Card not found.", 404);
}

/** Every 503 says when to come back, and no cache keeps it. */
function unavailable(body: string): Response {
  return publicErrorResponse(body.includes("busy") ? "CARD_BUSY" : "CARD_UNAVAILABLE", "The saved card could not be rendered. Please retry.", 503, {
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(CARD_IMAGE_RETRY_AFTER_SECONDS),
    },
  });
}

/**
 * The PNG as a response body without copying it: a view over the Buffer's own
 * memory. (Shared memory, which renders never use, is copied instead.)
 */
export { cardImageBody } from "@blast/core/modules/mission-control/card-images/body.ts";

function png(image: CardImage): Response {
  return new Response(cardImageBody(image.bytes), {
    headers: {
      "Cache-Control": PUBLIC_CARD_IMAGE_CACHE_CONTROL,
      "Content-Length": String(image.bytes.byteLength),
      "Content-Type": image.contentType,
    },
  });
}

function currentShareImage(cardId: string, recruitTotal: number): Response {
  return new Response(null, {
    status: 307,
    headers: {
      "Cache-Control": "no-store",
      Location: publicCardImagePath(cardId, "share", recruitTotal),
    },
  });
}

/** GET /card/[id]/image: a published card image; share format is the default for crawlers. */
export async function publicCardImageResponse(
  cardId: string,
  dependencies: PublicCardImageDependencies,
  format: "card" | "share" = "share",
  expectedRecruitTotal?: number,
): Promise<Response> {
  // Card ids in records are lowercase; the lookup below matches either case.
  const id = cardId.toLowerCase();
  try {
    const digest = format === "card" ? dependencies.published.get(id) : undefined;
    const remembered = digest === undefined
      ? null
      : dependencies.images.cached({ cardId: id, digest, format });
    if (remembered) {
      if (await dependencies.isPublished(id)) return png(remembered);
      dependencies.published.delete(id);
      return notFound();
    }

    const snapshot = await dependencies.publishedCard(id);
    if (!snapshot) return notFound();
    if (format === "share" && expectedRecruitTotal !== snapshot.recruitTotal) {
      return currentShareImage(id, snapshot.recruitTotal);
    }
    const image = await dependencies.images.image({
      format,
      record: snapshot.record,
      ...(format === "share" ? { shareStats: {
        recruitHandles: snapshot.recruitHandles,
        recruitTotal: snapshot.recruitTotal,
      } } : {}),
    });
    if (format === "card") dependencies.published.set(image.cardId, image.digest);
    return png(image);
  } catch (error) {
    if (error instanceof CardImageBusyError) return unavailable("Card rendering is busy; retry shortly");
    return unavailable("Card temporarily unavailable");
  }
}

/**
 * How long a background warm-up keeps waiting out busy renders before leaving
 * the card to the image route. A burst of publishes queues more share renders
 * than an instance draws at once; this lets it work through them.
 */
export const WARM_PUBLIC_CARD_IMAGE_BUDGET_MS = 120_000;

export type WarmPublicCardImageOutcome = "stored" | "unpublished" | "busy" | "failed";

/**
 * Draws and stores a just-published card's share image in the background, so
 * the first link-preview fetch (X's crawler, seconds after the member posts)
 * finds it stored rather than waiting on a render or being shed with 503,
 * which X would keep as a post without a picture. A busy instance is retried
 * after the advertised wait until the budget runs out; after that the image
 * route renders on demand as before. Never throws.
 */
export async function warmPublicCardImage(
  cardId: string,
  dependencies: Pick<PublicCardImageDependencies, "images" | "publishedCard"> & {
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
  },
): Promise<WarmPublicCardImageOutcome> {
  const id = cardId.toLowerCase();
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep
    ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const started = now();
  const waitMs = CARD_IMAGE_RETRY_AFTER_SECONDS * 1_000;
  let snapshot: PublishedCardSnapshot | null;
  try {
    snapshot = await dependencies.publishedCard(id);
  } catch {
    return "failed";
  }
  if (!snapshot) return "unpublished";
  // This snapshot is consistent across retries; a later recruit gets a new URL.
  for (;;) {
    try {
      await dependencies.images.image({
        format: "share",
        record: snapshot.record,
        shareStats: {
          recruitHandles: snapshot.recruitHandles,
          recruitTotal: snapshot.recruitTotal,
        },
      });
      return "stored";
    } catch (error) {
      if (!(error instanceof CardImageBusyError)) return "failed";
      if (now() - started + waitMs > WARM_PUBLIC_CARD_IMAGE_BUDGET_MS) return "busy";
      await sleep(waitMs);
    }
  }
}
