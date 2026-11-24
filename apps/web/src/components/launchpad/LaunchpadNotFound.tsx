import Link from "next/link";

import { LaunchpadPlaceholder } from "./LaunchpadShell";

/** The launchpad's 404 message: what happened and the way back. */
export function LaunchpadNotFound() {
  return (
    <LaunchpadPlaceholder title="Page not found">

      <p><Link href="/">Back to the terminal</Link></p>
    </LaunchpadPlaceholder>
  );
}
