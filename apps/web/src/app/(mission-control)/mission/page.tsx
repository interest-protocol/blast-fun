import { referralPageMetadata } from "#web/lib/backend-api/referrals.ts";
import type { ReferralSearchParams } from "#web/modules/social/referrals/share.ts";
import type { Metadata } from "next";
import { headers } from "next/headers";

import { BrandLanding } from "#web/components/landing/BrandLanding.tsx";
import { HOME_REWRITE_HEADER } from "@blast/core/lib/mission-control/route-policy.ts";
import { SITE_ORIGIN } from "#web/lib/site.ts";
import { siteMetadata } from "#web/lib/site-metadata.ts";

export async function generateMetadata({ searchParams }: Readonly<{ searchParams: ReferralSearchParams }>): Promise<Metadata> {
  const referral = await referralPageMetadata(searchParams);
  if (referral) return referral;
  // The proxy also serves this landing at `/` when other home surfaces are off.
  const home = (await headers()).get(HOME_REWRITE_HEADER) === "1";
  const entryUrl = home ? SITE_ORIGIN : `${SITE_ORIGIN}/mission`;
  return {
    alternates: { canonical: home ? "/" : "/mission" },
    openGraph: siteMetadata(entryUrl).openGraph,
  };
}

export default function MissionLanding() {
  return <BrandLanding />;
}
