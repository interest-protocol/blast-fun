"use client";

import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { StyleSheetManager } from "styled-components";
import { EnableWallets, type WalletMode } from "./privy-wallet-picker";
import { documentNonce } from "./privy-nonce";

const PrivyApp = createContext<string | null>(null);

export function PrivyAuthProvider({
  appId,
  nonce,
  externalWallets,
  deferWalletPicker = false,
  theme,
  children,
}: Readonly<{
  appId: string;
  nonce: string | null;
  externalWallets?: PrivyClientConfig["externalWallets"];
  deferWalletPicker?: boolean;
  theme?: "light" | "dark";
  children: ReactNode;
}>) {
  const owner = useContext(PrivyApp);
  const [mode, setMode] = useState<WalletMode | null>(null);
  const enableWallets = useCallback((next: WalletMode | null) => {
    setMode((current) => current === "picker" ? current : next);
  }, []);
  const config = useMemo<PrivyClientConfig>(
    () => ({
      loginMethods: ["twitter", "google"],
      externalWallets,
      appearance: {
        theme,
        // Privy initializes a WalletConnect Core for each enabled QR chain as soon as
        // its default wallet list is installed. The public page only needs session restore.
        walletList: deferWalletPicker && mode !== "picker" ? [
          "detected_ethereum_wallets", "detected_solana_wallets",
          ...(mode ? [mode] : []),
        ] : undefined,
      },
    }),
    [deferWalletPicker, externalWallets, mode, theme],
  );
  // Client navigation carries a new request nonce; the document's CSP still uses its original.
  const [styleNonce] = useState(() => documentNonce(nonce));
  if (owner === appId) return children;
  const session = (
    <PrivyProvider appId={appId} config={config}>
      <PrivyApp value={appId}>
        <EnableWallets value={enableWallets}>{children}</EnableWallets>
      </PrivyApp>
    </PrivyProvider>
  );

  return styleNonce ? <StyleSheetManager nonce={styleNonce}>{session}</StyleSheetManager> : session;
}
