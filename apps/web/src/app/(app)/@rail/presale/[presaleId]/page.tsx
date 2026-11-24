import { isPresaleId } from "@blast/core/modules/presale/presale-id.ts";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";


const loadPresaleComponents = () => import("#web/components/presale-pages/server.tsx");

// A sale page's right column: its side box and "People you follow" (FEATURE-MAP §10.4).
export default async function SaleRailPage({ params }: Readonly<{ params: Promise<{ presaleId: string }> }>) {
  const { presaleId } = await params;
  if (!(await requestLaunchFlags()).social || !isPresaleId(presaleId)) return null;
  const { SaleRail } = await loadPresaleComponents();
  return <SaleRail presaleId={presaleId} />;
}
