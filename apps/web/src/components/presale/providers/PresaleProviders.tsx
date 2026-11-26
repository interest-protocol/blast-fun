import { ClientProvider } from "./ClientProvider";
import { ConfigProvider } from "./ConfigProvider";
import { SdkProvider } from "./SdkProvider";
import { SettingsSyncProvider } from "./SettingsSyncProvider";
import type { PresaleShellProps } from "./slot";
import { ThemeProvider } from "./ThemeProvider";
import { WalletProvider } from "./WalletProvider";

/** The presale provider root: the six slots in their fixed order. Do not edit to fill a slot. */
export function PresaleProviders({ config, nonce, privySession, children }: PresaleShellProps) {
  return (
    <ConfigProvider config={config} nonce={nonce}>
      <ClientProvider config={config} nonce={nonce}>
        <SdkProvider config={config} nonce={nonce}>
          <WalletProvider config={config} nonce={nonce} privySession={privySession}>
            <ThemeProvider config={config} nonce={nonce}>
              <SettingsSyncProvider config={config} nonce={nonce}>
                {children}
              </SettingsSyncProvider>
            </ThemeProvider>
          </WalletProvider>
        </SdkProvider>
      </ClientProvider>
    </ConfigProvider>
  );
}
