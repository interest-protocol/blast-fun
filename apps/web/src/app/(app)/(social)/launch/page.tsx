import type { Metadata } from "next";

import { LaunchScreen } from "#web/components/social/launch/LaunchScreen.tsx";
import { readLaunchContextFromBackend } from "#web/lib/backend-api/launch-context.ts";

export const metadata: Metadata = { title: "Launch a coin", robots: { index: false, follow: false }, alternates: { canonical: "/launch" } };

/**
 * `/launch`: create a bonding-curve coin. The signed-in account's launch
 * draft is read and saved in the browser with the viewer's credentials
 * (personal data, never server-rendered or cached); the server passes only
 * what is the same for everyone: the deployed launchpad's rules, or why
 * launching is off.
 */
export default async function LaunchPage() {
  return <LaunchScreen context={await readLaunchContextFromBackend()} />;
}
