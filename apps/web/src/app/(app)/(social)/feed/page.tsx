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
import { HOME_DEFAULT_WINDOW } from "@blast/core/web/contracts/home.ts";
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

/** Start visible reads together. Only the launch highlights gate the first paint. */
async function loadHome(state: HomeViewState, sections: HomeSectionPrefs, rows: number) {
  await connection();
  const shown = (key: Parameters<typeof isHomeSectionShown>[1]) => isHomeSectionShown(sections, key);
  const coins = shown("coins") && state.source === "discover" ? readHomeFromBackend(discoverQueryOf(state, rows)).catch(failed("discover")) : null;
  const happening = shown("presales") ? homeHappening() : null;
  const presales = shown("presales") && happening
    ? happening.then(({ read, nowMs }) => readHomeCoinsFromBackend(presaleIdsOf(read, nowMs).ids, state.window)).catch(failed("presales"))
    : null;
  const traders = shown("traders") ? readHomeTradersFromBackend(HOME_DEFAULT_WINDOW).catch(failed("traders")) : null;
  const posts = shown("posts") ? readFeedPageFromBackend().catch(failed("posts")) : null;
  // Once the highlights land, a ready coins result can paint directly; an unfinished read streams into the card.
  const [pinnedPresales, pinnedCurves, initial] = await Promise.all([
    readFeaturedPresalesFromBackend().catch(failed("pinned-presales")),
    readBondingHeroFromBackend().then((seed) => seed ?? failed("pinned-curves")()),
  ]).then(async ([presales, curves]) => [presales, curves, await Promise.race([coins, coinsPending] as const)] as const);
  return {
    coins: initial === coinsPending ? coins : initial,
    happening: happening?.then(({ read }) => read) ?? null, presales, traders, posts,
    pinned: { presales: pinnedPresales, curves: pinnedCurves, seed: crypto.randomUUID() },
  };
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
  const { trading } = await requestLaunchFlags();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value);
  }
  const state = viewStateOf(params);
  const jar = await cookies();
  const sections = parseHomeSections(jar.get(HOME_SECTIONS_COOKIE)?.value);
  const rows = parseHomeRows(jar.get(HOME_ROWS_COOKIE)?.value);
  const loaded = await loadHome(state, sections, rows);
  return (
    <CoinHome
      happening={loaded.happening}
      initial={loaded.coins}
      initialRows={rows}
      initialState={state}
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
