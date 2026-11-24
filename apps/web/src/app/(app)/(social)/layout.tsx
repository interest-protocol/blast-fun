import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { presaleConfigFor } from "#web/components/presale/config.ts";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";
import { webConfig } from "#web/lib/server-config.ts";

// FEATURE-MAP §0.3: page titles read `<Page> · Blast`; Home is just `Blast`.
export const metadata: Metadata = { title: { default: "Blast", template: "%s · Blast" } };

/**
 * The social pages: `/` (rewritten to `/feed` by the proxy) and `/@<callsign>`
 * (rewritten to `/crew/<callsign>`). They sit in the app shell of
 * `(app)/layout.tsx`, shared with the presale pages and Settings so the shell
 * stays mounted between them. The proxy already keeps these paths away while
 * `BLAST_SOCIAL_ENABLED` or `BLAST_PRESALE_ENABLED` is off for this request (a
 * "team" flag without the team cookie is off); this guards paths it does not
 * match. The flags are read per request (`requestLaunchFlags`).
 */
export default async function SocialLayout({ children }: Readonly<{ children: ReactNode }>) {
  const flags = await requestLaunchFlags();
  if (!flags.social || !presaleConfigFor(webConfig().presale, flags.presale).enabled) notFound();
  return children;
}
