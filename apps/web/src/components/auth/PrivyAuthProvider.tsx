"use client";

import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { StyleSheetManager } from "styled-components";
import { EnableWallets, type WalletMode } from "./privy-wallet-picker";
import { documentNonce } from "./privy-nonce";

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
  const session = (
    <PrivyProvider appId={appId} config={config}>
      <EnableWallets value={enableWallets}>{children}</EnableWallets>
    </PrivyProvider>
  );

  return styleNonce ? <StyleSheetManager nonce={styleNonce}>{session}</StyleSheetManager> : session;
}
