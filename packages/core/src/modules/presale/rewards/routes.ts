import { addressSchema } from "../contracts/primitives.ts";
// `GET /api/presale/rewards/rounds/{round_id}/manifest` (contract 3.8, CL-13,
// CL-21): public, no auth. A published round's manifest (the SDK
// `RewardManifest` plus its accounting) is the public Blob object the rewards
// worker wrote, byte for byte and hash-checked, before it signed. The route
// answers `308` to that object rather than carrying the body itself: a
// manifest reaches about 81 MB at 65,536 leaves, far past a function's
// response limit. Once published the manifest never changes, so the redirect
// is `public, max-age=31536000, immutable`, like the object. A round that is
// not published (prepared, abandoned, mismatched, or unknown) is `not_found`;
// a malformed id is `invalid_parameter`.

import { PresaleRouteError } from "../route-kit/errors.ts";
import type { PresaleRouteKit } from "../route-kit/route.ts";

/** Where the route finds a published round's manifest: its public Blob URL, or null. */
export type PublishedManifests = Readonly<{
  publishedManifestUrl(roundId: string): Promise<string | null>;
}>;

/** A published manifest's cache policy: it is immutable once its round is on chain. */
export const MANIFEST_CACHE_CONTROL = "public, max-age=31536000, immutable";

const PATH = /^\/api\/presale\/rewards\/rounds\/([^/]+)\/manifest\/?$/;

function roundIdOf(request: Request): string {
  const match = PATH.exec(new URL(request.url).pathname);
  const id = match ? decodeURIComponent(match[1]!) : "";
  if (!addressSchema.safeParse(id).success) throw new PresaleRouteError("invalid_parameter");
  return id;
}

export function createRewardManifestRoutes(
  dependencies: Readonly<{ kit: PresaleRouteKit; rounds: PublishedManifests }>,
) {
  const { kit, rounds } = dependencies;
  return Object.freeze({
    manifest: kit.route(
      {
        name: "GET /api/presale/rewards/rounds/{round_id}/manifest",
        auth: "none",
        bucket: "presale_reward_proof",
      },
      async (context) => {
        const roundId = roundIdOf(context.request);
        const url = await rounds.publishedManifestUrl(roundId);
        if (url === null) throw new PresaleRouteError("not_found");
        return new Response(null, {
          status: 308,
          headers: {
            Location: url,
            "Cache-Control": MANIFEST_CACHE_CONTROL,
            "X-Request-ID": context.requestId,
          },
        });
      },
    ),
  });
}

export type RewardManifestRoutes = ReturnType<typeof createRewardManifestRoutes>;
