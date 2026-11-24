import { LaunchpadNotFound } from "#web/components/launchpad/LaunchpadNotFound.tsx";

// `notFound()` from a launchpad page (such as a malformed launch ID). It
// renders inside the launchpad layout, which already provides the shell; the
// page's own metadata supplies the title.
export default function LaunchpadSegmentNotFound() {
  return <LaunchpadNotFound />;
}
