import { referralPageMetadata } from "#web/lib/backend-api/referrals.ts";
import type { ReferralSearchParams } from "#web/modules/social/referrals/share.ts";
import type { Metadata } from "next";

import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";


const loadPresaleComponents = () => import("#web/components/presale-pages/server.tsx");

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

export async function generateMetadata({ searchParams }: Readonly<{ searchParams: ReferralSearchParams }>): Promise<Metadata> {
  const referral = await referralPageMetadata(searchParams);
  if (referral) return referral;
  return (await requestLaunchFlags()).social ? { title: { absolute: "Presales · Blast" } } : {};
}

// While the social feed is on: the canonical UI's presales list, server
// rendered from the replica. With it off it stays the presale placeholder.
// The section's code loads only while the feed is on, so flags off changes nothing.
export default async function PresalesPage({ searchParams }: Readonly<{ searchParams: SearchParams }>) {
  if (!(await requestLaunchFlags()).social) {
    return (
      <main>
        <PageHeader title="Presales" />
      </main>
    );
  }
  const { PresalesListPage } = await loadPresaleComponents();
  return <PresalesListPage searchParams={searchParams} />;
}
