import type { Metadata } from "next";

import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { SettingsBackBar } from "#web/components/social/settings/SettingsBackBar.tsx";
import { SettingsScreen } from "#web/components/social/settings/SettingsScreen.tsx";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";

/** The canonical UI's title while the feed is on ("Settings · Blast"); unchanged with it off. */
export async function generateMetadata(): Promise<Metadata> {
  return (await requestLaunchFlags()).social ? { title: { absolute: "Settings · Blast" } } : {};
}

// While the social feed is on, the page sits in the app shell (its layout
// passes `socialShell` and the right column's "Your wallet"): the canonical
// UI's Settings (FEATURE-MAP §7). With the feed off it stays the presale
// placeholder. Settings opens from Profile, so a back bar above the title
// names the page you came from (R3-76).
export default async function SettingsPage() {
  if (!(await requestLaunchFlags()).social) {
    return (
      <main>
        <PageHeader title="Settings" />
      </main>
    );
  }
  return (
    <>
      <SettingsBackBar />
      <PageHeader title="Settings" />
      <SettingsScreen />
    </>
  );
}
