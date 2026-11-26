import { PrivySessionProvider } from "./PrivySessionProvider";
import type { PresaleSlotProps } from "./slot";

/**
 * Slot 4: Privy and dapp-kit wallets. It holds the Privy session (social
 * T-013 wiring: the social viewer and onboarding need it) whenever
 * `PRIVY_APP_ID` is set, and passes through otherwise. The presale wallet
 * ticket extends this file with dapp-kit and the Privy login configuration.
 */
export function WalletProvider({ config, nonce, privySession, children }: PresaleSlotProps) {
  if (config.privyAppId.status !== "available") return <>{children}</>;
  return (
    <PrivySessionProvider appId={config.privyAppId.value} nonce={nonce} sessionCookie={privySession}>
      {children}
    </PrivySessionProvider>
  );
}
