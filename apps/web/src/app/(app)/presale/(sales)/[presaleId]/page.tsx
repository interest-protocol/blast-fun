import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { isPresaleId } from "@blast/core/modules/presale/presale-id.ts";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { LiveScreen } from "#web/components/launchpad/coin/LiveScreen.tsx";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";
import { presaleShareMetadata } from "#web/modules/presale/share/metadata.ts";


const loadPresaleReads = () => import("#web/components/presale-pages/server-reads.ts");
const loadPresaleComponents = () => import("#web/components/presale-pages/server.tsx");

type Params = Promise<{ presaleId: string }>;

export async function generateMetadata({ params }: Readonly<{ params: Params }>): Promise<Metadata> {
  if (!(await requestLaunchFlags()).social) return {};
  const [{ presaleId }, { saleOf }] = await Promise.all([params, loadPresaleReads()]);
  if (!isPresaleId(presaleId)) notFound();
  const read = await saleOf(presaleId);
  if (read.status === "missing") notFound();
  return read.status === "ok" ? presaleShareMetadata(read.detail.presale) : { title: { absolute: "Presale · Blast" } };
}

// While the social feed is on: the canonical UI's sale page, server rendered
// from the replica. With it off it stays the presale placeholder. The live screen
// (`BLAST_LIVE_SCREEN_ENABLED`, as on `/coin/<key>`) lets a graduated sale's chart and
// market reads rest while the tab's stream carries the coin.
export default async function PresalePage({ params }: Readonly<{ params: Params }>) {
  const { presaleId } = await params;
  if (!isPresaleId(presaleId)) notFound();
  const flags = await requestLaunchFlags();
  if (!flags.social) {
    return (
      <main>
        <PageHeader title="Presale" />
      </main>
    );
  }
  const { SaleDetailPage } = await loadPresaleComponents();
  return <LiveScreen enabled={flags.liveScreen}><SaleDetailPage presaleId={presaleId} /></LiveScreen>;
}
