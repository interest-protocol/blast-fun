import { mainnetIdentity } from "@blast/core/modules/presale/deployment/mainnet-identity.ts";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { FeelProvider } from "#web/components/blast-feel/index.ts";
import { BlastUiRoot } from "#web/components/blast-ui/BlastUiRoot.tsx";
import { presaleConfigFor } from "#web/components/presale/config.ts";
import { PresaleProviders } from "#web/components/presale/providers/PresaleProviders.tsx";
import { SocialSession } from "#web/components/social/SocialSession.tsx";
import { SocialShell } from "#web/components/social/SocialShell.tsx";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";
import { webConfig } from "#web/lib/server-config.ts";

import { SITE_ORIGIN } from "#web/lib/site.ts";
import { backendPrivateServerRead } from "@blast/server/private/relay.ts";
import { readHeaderSession } from "#web/modules/social/accounts/header-session.ts";
import { TestPricingNotice } from "#web/components/social/TestPricingNotice.tsx";
import { TestPricingProvider } from "#web/components/social/test-pricing-context.tsx";
import { testSuiPriceEnabled } from "@blast/core/modules/social/prices/test-sui.ts";

/** Shared shell and session survive navigation between social, presale, settings and sign-in pages. */
export default async function AppLayout({
  children,
  rail,
  banner,
}: Readonly<{ children: ReactNode; rail: ReactNode; banner: ReactNode }>) {
  const requestHeaders = await headers();
  const nonce = requestHeaders.get("x-nonce");
  const flags = await requestLaunchFlags();
  const config = presaleConfigFor(webConfig().presale, flags.presale);
  if (!flags.social || !config.enabled) return children;
  // Blasting is gated on the presale deployment manifest, as publishing is.
  const presaleDeployed = mainnetIdentity(webConfig().presaleDeployment) !== null;
  const initialSession = await readHeaderSession(
    new Request(`${SITE_ORIGIN}/api/social/me`, { headers: requestHeaders }),
    backendPrivateServerRead,
    config.privyAppId.status === "available",
  );
  return (
    <BlastUiRoot nonce={nonce}>
      <FeelProvider>
        <PresaleProviders config={config} nonce={nonce}>
          <SocialSession>
            <TestPricingProvider enabled={testSuiPriceEnabled()}>
            <SocialShell banner={testSuiPriceEnabled() ? <><TestPricingNotice enabled />{banner}</> : banner} initialSession={initialSession} presaleDeployed={presaleDeployed} launchpad={flags.launchpad} rail={rail}>
              {children}
            </SocialShell>
            </TestPricingProvider>
          </SocialSession>
        </PresaleProviders>
      </FeelProvider>
    </BlastUiRoot>
  );
}
