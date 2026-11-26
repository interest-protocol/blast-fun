import type { Metadata } from "next";
import { LaunchpadTerminal } from "#web/components/launchpad/LaunchpadTerminal.tsx";
import { placeholderTerminalSlots } from "#web/components/launchpad/terminal-placeholders.tsx";

// `/` when the social feed is off: Home names its own address.
export const metadata: Metadata = { alternates: { canonical: "/" } };

export default function LaunchpadHome() {
  return <LaunchpadTerminal {...placeholderTerminalSlots(null)} initialMobileView="discover" />;
}
