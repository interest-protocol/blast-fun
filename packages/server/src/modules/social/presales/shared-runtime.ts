import { optionalSource } from "../optional-source.ts";
import { replicaPool } from "@blast/core/modules/database/pool.ts";
import { publicReadCache } from "@blast/server/modules/public-reads/shared-runtime.ts";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { createPresaleTermsReader } from "@blast/core/modules/presale/terms/index.ts";
import { blastInfraFetch } from "@blast/core/modules/read-routing/blast-infra.ts";
import { getSocialConfig } from "@blast/core/modules/social/config/reader.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import type { SocialCaller } from "@blast/server/modules/social/route-kit/route.ts";

import type { PresaleTermsSource } from "@blast/server/modules/social/presales/detail.ts";
import { createSocialPresaleRoutes } from "@blast/server/modules/social/presales/route.ts";
import { createPresaleFollowReader } from "@blast/server/modules/social/presales/follow-reader.ts";

/**
 * The presale pages read on the read replica (`blast_replica`), never the
 * primary; without `DATABASE_REPLICA_URL` the routes answer
 * `service_unavailable`. Terms come from blast-infra
 * (`BLAST_INFRA_ORIGIN`, 3 s, with its key), kept 5 minutes per sale once the
 * split is final and no longer than the routes' shared-cache life before the
 * sale starts, while Blast's rates for it may still change.
 */
export function socialPresaleDatabase(): ReadableDatabase {
  return autocommitReader(replicaPool(), "social", { label: "social.presales" });
}

/** The public presale routes' shared-cache life (`SOCIAL_PUBLIC_CACHE_CONTROL`'s `s-maxage=10`). */
const ROUTE_CACHE_MS = 10_000;

export const readPresaleTerms: PresaleTermsSource = (presaleId) =>
  optionalSource("presale_terms", () => processSingleton("social.presale-terms", () => {
    const { infra } = runtimeConfig();
    return createPresaleTermsReader({
      origin: () => infra.origin,
      fetch: blastInfraFetch({ infra }),
      timeoutMs: 3_000,
      cacheMs: 300_000,
      beforeStartCacheMs: ROUTE_CACHE_MS,
    });
  })(presaleId), null);

export function socialPresaleRoutes(): ReturnType<typeof createSocialPresaleRoutes> {
  return processSingleton("social.presale-routes", () =>
    createSocialPresaleRuntimeRoutes(sharedSocialRouteKit()));
}

const followingDatabase: ReadableDatabase = {
  async read(text, values, rowMode) {
    const reader = processSingleton(
      "social.presale-follow-reader",
      () => createPresaleFollowReader(replicaPool(), runtimeConfig().presaleFollow),
    );
    return reader.read(text, values, rowMode);
  },
};

/** Bind public reads to a transport's kit while sharing replica reads and coalescing. */
export function createSocialPresaleRuntimeRoutes(kit: SocialRouteKit, blastWallet?: (caller: SocialCaller) => Promise<string | null>): ReturnType<typeof createSocialPresaleRoutes> {
  return createSocialPresaleRoutes({
    kit,
    database: socialPresaleDatabase,
    followingDatabase,
    config: getSocialConfig,
    terms: readPresaleTerms,
    blastWallet,
    publicRead: publicReads(),
  });
}

const publicReads = () => publicReadCache("presales");
