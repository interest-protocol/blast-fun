import { mainnetIdentity } from "@blast/core/modules/presale/deployment/mainnet-identity.ts";
import { testSuiPriceEnabled } from "@blast/core/modules/social/prices/test-sui.ts";
import { backendPrivateServerRead } from "@blast/server/private/relay.ts";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { FeelProvider } from "#web/components/blast-feel/index.ts";
import { BlastUiRoot } from "#web/components/blast-ui/BlastUiRoot.tsx";
import { PresaleProviders } from "#web/components/presale/providers/PresaleProviders.tsx";
import { SocialSession } from "#web/components/social/SocialSession.tsx";
import { SocialShell } from "#web/components/social/SocialShell.tsx";
import { TestPricingNotice } from "#web/components/social/TestPricingNotice.tsx";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";
import { webConfig } from "#web/lib/server-config.ts";
import { SITE_ORIGIN } from "#web/lib/site.ts";
import { readHeaderSession } from "#web/modules/social/accounts/header-session.ts";

/** Shared shell and session survive navigation between social, presale, settings and sign-in pages. */
export default async function AppLayout({
  children,
  rail,
  banner,
}: Readonly<{ children: ReactNode; rail: ReactNode; banner: ReactNode }>) {
  const { social } = await requestLaunchFlags();
  if (!social) {
    return children;
  }

  const { presale: config, presaleDeployment } = webConfig();
  const requestHeaders = await headers();
  const nonce = requestHeaders.get("x-nonce");
  const initialSession = await readHeaderSession(
    new Request(`${SITE_ORIGIN}/api/social/me`, { headers: requestHeaders }),
    backendPrivateServerRead,
    config.privyAppId.status === "available",
  );

  const testPricing = testSuiPriceEnabled();
  const shellBanner = (
    <>
      <TestPricingNotice enabled={testPricing} />
      {banner}
    </>
  );
  const shell = (
    <SocialShell
      banner={shellBanner}
      initialSession={initialSession}
      presaleDeployed={mainnetIdentity(presaleDeployment) !== null}
      rail={rail}
    >
      {children}
    </SocialShell>
  );

  return (
    <BlastUiRoot nonce={nonce}>
      <FeelProvider>
        <PresaleProviders config={config} nonce={nonce}>
          <SocialSession>
            {shell}
          </SocialSession>
        </PresaleProviders>
      </FeelProvider>
    </BlastUiRoot>
  );
}
