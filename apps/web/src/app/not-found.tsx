import type { Metadata } from "next";

import { LaunchpadNotFound } from "#web/components/launchpad/LaunchpadNotFound.tsx";
import { LaunchpadShell } from "#web/components/launchpad/LaunchpadShell.tsx";
import { LaunchpadSearch } from "#web/components/launchpad/search/LaunchpadSearch.tsx";
import { webConfig } from "#web/lib/server-config.ts";

// Absolute, as the app's other titles read `<Page> · Blast` (FEATURE-MAP §0.3).
export const metadata: Metadata = {
  title: { absolute: "Page not found · Blast" },
};

// The app's 404 for unmatched URLs (including unknown `/coin` and `/launch`
// subpaths) and `notFound()` outside the launchpad. It renders only inside the
// root layout, so it brings the launchpad shell itself. It never mounts Privy.
export default function NotFound() {
  return (
    <LaunchpadShell boostsUrl={webConfig().boostsUrl} search={<LaunchpadSearch />}>
      <LaunchpadNotFound />
    </LaunchpadShell>
  );
}
