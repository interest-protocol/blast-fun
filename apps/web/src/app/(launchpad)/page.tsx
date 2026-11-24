import { LaunchpadTerminal } from "#web/components/launchpad/LaunchpadTerminal.tsx";
import { placeholderTerminalSlots } from "#web/components/launchpad/terminal-placeholders.tsx";

export default function LaunchpadHome() {
  return <LaunchpadTerminal {...placeholderTerminalSlots(null)} initialMobileView="discover" />;
}
