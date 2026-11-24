import type { Metadata } from "next";

import { LaunchpadNotFound } from "#web/components/launchpad/LaunchpadNotFound.tsx";
import { LaunchpadShell } from "#web/components/launchpad/LaunchpadShell.tsx";
import { LaunchpadSearch } from "#web/components/launchpad/search/LaunchpadSearch.tsx";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";
import { webConfig } from "#web/lib/server-config.ts";

export const metadata: Metadata = {
  title: "Page not found",
};

// The app's 404 for unmatched URLs (including unknown `/coin` and `/launch`
// subpaths) and `notFound()` outside the launchpad. It renders only inside the
// root layout, so it brings the launchpad shell itself. It never mounts Privy.
// While the launchpad is off it
// is neutral: no launchpad shell, search, Boosts link or link into the
// launchpad.
export default async function NotFound() {
  if (!(await requestLaunchFlags()).launchpad) {
    return (
      <main>
        <h1>Page not found</h1>
      </main>
    );
  }
  return (
    <LaunchpadShell boostsUrl={webConfig().boostsUrl} search={<LaunchpadSearch />}>
      <LaunchpadNotFound />
    </LaunchpadShell>
  );
}
