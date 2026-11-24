import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { SocialSession } from "#web/components/social/SocialSession.tsx";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";
import { webConfig } from "#web/lib/server-config.ts";

import { presaleConfigFor } from "../config";
import { PresaleShell } from "./PresaleShell";

/**
 * The layout of `/presale`, `/sign-in` and `/settings`. It renders per request
 * because the CSP nonce is per request. The proxy already answers not-found
 * while the presale is off; this guards paths the proxy does not match.
 * While the social feed is on, the page sits in `SocialSession` (the viewer,
 * the shared `me` read and the wallet session). A layout that passes
 * `socialShell` (the presales list and sale pages, `/settings`, `/sign-in`)
 * sits in the app shell of `src/app/(app)/layout.tsx` instead, which already
 * holds the providers, the session and the shell's overlays (UI-08), so it
 * adds nothing here. With the feed off nothing changes.
 */
export async function PresaleLayout({
  children,
  socialShell = false,
}: Readonly<{ children: ReactNode; socialShell?: boolean }>) {
  // Read the request first: it keeps every presale page dynamic, so the build
  // never prerenders a page from its own environment.
  const nonce = (await headers()).get("x-nonce");
  const flags = await requestLaunchFlags();
  const config = presaleConfigFor(webConfig().presale, flags.presale);
  if (!config.enabled) notFound();
  if (!flags.social) {
    return (
      <PresaleShell config={config} nonce={nonce}>
        {children}
      </PresaleShell>
    );
  }
  if (socialShell) return children;
  return (
    <PresaleShell config={config} nonce={nonce}>
      <SocialSession>{children}</SocialSession>
    </PresaleShell>
  );
}
