import { referralPageMetadata } from "#web/lib/backend-api/referrals.ts";
import type { ReferralSearchParams } from "#web/modules/social/referrals/share.ts";
import type { Metadata } from "next";

import { BrandLanding } from "#web/components/landing/BrandLanding.tsx";
import { SITE_ORIGIN } from "#web/lib/site.ts";
import { siteMetadata } from "#web/lib/site-metadata.ts";

export async function generateMetadata({ searchParams }: Readonly<{ searchParams: ReferralSearchParams }>): Promise<Metadata> {
  const referral = await referralPageMetadata(searchParams);
  if (referral) return referral;
  return {
    alternates: { canonical: "/mission" },
    openGraph: siteMetadata(`${SITE_ORIGIN}/mission`).openGraph,
  };
}

export default function MissionLanding() {
  return <BrandLanding />;
}
