import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";

// FEATURE-MAP §0.3: page titles read `<Page> · Blast`; Home is just `Blast`.
export const metadata: Metadata = { title: { default: "Blast", template: "%s · Blast" } };

/**
 * The social pages: `/` (rewritten to `/feed` by the proxy) and `/@<callsign>`
 * (rewritten to `/crew/<callsign>`). They sit in the app shell of
 * `(app)/layout.tsx`, shared with the presale pages and Settings so the shell
 * stays mounted between them.
 */
export default async function SocialLayout({ children }: Readonly<{ children: ReactNode }>) {
  const flags = await requestLaunchFlags();
  if (!flags.social) notFound();
  return children;
}
