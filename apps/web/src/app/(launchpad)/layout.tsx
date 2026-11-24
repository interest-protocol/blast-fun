import { LaunchpadShell } from "#web/components/launchpad/LaunchpadShell.tsx";
import { LaunchpadSearch } from "#web/components/launchpad/search/LaunchpadSearch.tsx";
import { webConfig } from "#web/lib/server-config.ts";
import { TestPricingNotice } from "#web/components/social/TestPricingNotice.tsx";
import { testSuiPriceEnabled } from "@blast/core/modules/social/prices/test-sui.ts";

// Stable slot for every public launchpad route. Public read providers mount
// here; auth providers (Privy) must not, so signed-out readers never need
// PRIVY_APP_ID or an auth handshake.
export default function LaunchpadLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <LaunchpadShell boostsUrl={webConfig().boostsUrl} search={<LaunchpadSearch />}>
      <TestPricingNotice enabled={testSuiPriceEnabled()} />
      {children}
    </LaunchpadShell>
  );
}
