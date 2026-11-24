import { referralPageMetadata } from "#web/lib/backend-api/referrals.ts";
import type { ReferralSearchParams } from "#web/modules/social/referrals/share.ts";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { cache } from "react";

import { CoinHome } from "#web/components/social/coin-home/CoinHome.tsx";
import { HOME_ROWS_COOKIE, parseHomeRows } from "#web/components/social/coin-home/home-rows.ts";
import { HOME_SECTIONS_COOKIE, isHomeSectionShown, parseHomeSections, type HomeSectionPrefs } from "#web/components/social/coin-home/home-sections.ts";
import { presaleIdsOf } from "#web/components/social/coin-home/presale-ids.ts";
import { discoverQueryOf, viewStateOf, type HomeViewState } from "#web/components/social/coin-home/home-state.ts";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";
import { readBondingHeroFromBackend } from "#web/lib/backend-api/bonding.ts";
import { readFeaturedPresalesFromBackend } from "#web/lib/backend-api/presales.ts";
import { readFeedPageFromBackend, readHomeCoinsFromBackend, readHomeFromBackend, readHomeTradersFromBackend } from "#web/lib/backend-api/social-reads.ts";

import { homeHappening } from "./home-happening";

// Home's title is the brand alone (FEATURE-MAP §0.3).
export async function generateMetadata({ searchParams }: Readonly<{ searchParams: ReferralSearchParams }>): Promise<Metadata> {
  return await referralPageMetadata(searchParams) ?? { title: { absolute: "Blast" } };
}

const requestNow = cache((): number => Date.now());
const coinsPending = Symbol("coins pending");

const failed = (read: string) => () => { recordMetric("social.home", { outcome: "error", read }); return null; };

/** Load the other sections alongside Discover so a slow Coins read only suspends its own panel. */
async function loadHome(state: HomeViewState, sections: HomeSectionPrefs, rows: number, launchpad: boolean) {
  await connection();
  const shown = (key: Parameters<typeof isHomeSectionShown>[1]) => isHomeSectionShown(sections, key);
  const coins = shown("coins") && state.source === "discover"
    ? readHomeFromBackend(discoverQueryOf(state, rows)).catch(failed("discover"))
    : null;
  const happening = homeHappening();
  return Promise.all([
    happening,
    shown("presales") ? happening.then(({ read }) => readHomeCoinsFromBackend(presaleIdsOf(read, Date.now()).ids, state.window)).catch(failed("presales")) : null,
    shown("traders") ? readHomeTradersFromBackend(state.window).catch(failed("traders")) : null,
    shown("posts") ? readFeedPageFromBackend().catch(failed("posts")) : null,
    // Blast's pins lead the page, so they are in the first paint: both lists and the curves' details come from the backend's 10 s shared caches.
    readFeaturedPresalesFromBackend().catch(failed("pinned-presales")),
    launchpad ? readBondingHeroFromBackend().then((seed) => seed ?? failed("pinned-curves")()) : null,
  ]).then(async ([{ read }, presales, traders, posts, pinnedPresales, pinnedCurves]) => {
    // A ready result can paint directly. An unfinished read streams into the card.
    const initial = await Promise.race([coins, coinsPending] as const);
    return { coins: initial === coinsPending ? coins : initial, happening: read, presales, traders, posts, pinned: { presales: pinnedPresales, curves: pinnedCurves, seed: crypto.randomUUID() } };
  });
}

/**
 * `/` while the social feed is on (an internal rewrite): the coin-centred
 * Home. The URL's view (`?src=&sort=&w=…`) chooses the source, sort, window
 * and filters; the `blast.home` cookie (the device's choice, never the
 * server's) chooses which sections show and in what order. Discover's first
 * page is read on the server exactly as `GET /api/social/home` reads it (on
 * the replica), the traders and the presales beside it, each only when its
 * section shows. Following and the Watchlist are the viewer's and read in
 * the browser.
 */
export default async function SocialHomePage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const { launchpad, trading } = await requestLaunchFlags();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value);
  }
  const state = viewStateOf(params);
  const jar = await cookies();
  const sections = parseHomeSections(jar.get(HOME_SECTIONS_COOKIE)?.value);
  const rows = parseHomeRows(jar.get(HOME_ROWS_COOKIE)?.value);
  const loaded = await loadHome(state, sections, rows, launchpad);
  return (
    <CoinHome
      happening={loaded.happening}
      initial={loaded.coins}
      initialRows={rows}
      initialState={state}
      launchpad={launchpad}
      nowMs={requestNow()}
      pinned={loaded.pinned}
      presales={loaded.presales}
      sections={sections}
      traders={loaded.traders}
      posts={loaded.posts}
      trading={trading}
    />
  );
}
