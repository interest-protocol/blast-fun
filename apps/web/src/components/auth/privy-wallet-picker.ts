import type { User } from "@privy-io/react-auth";
import { createContext, useContext, useEffect } from "react";

export type WalletMode = "wallet_connect_qr" | "wallet_connect_qr_solana" | "coinbase_wallet" | "base_account" | "picker";
export const EnableWallets = createContext<((mode: WalletMode | null) => void) | null>(null);

/** Mobile pairing and QR connectors are needed when Blast offers its wallet sign-in choices. */
export function usePreparePrivyWalletPicker(visible: boolean) {
  const enable = useContext(EnableWallets);
  useEffect(() => {
    if (visible) enable?.("picker");
  }, [enable, visible]);
}

type SavedWallet = Pick<NonNullable<User["wallet"]>, "chainType" | "connectorType" | "walletClientType">;

function savedWalletOption(wallet?: SavedWallet): WalletMode | null {
  if (!wallet) return null;
  const { chainType, connectorType, walletClientType } = wallet;
  // Privy records Solana QR sessions as solana_adapter with the remote peer's brand.
  // Injected Solana sessions share that tag, so restore this chain for either.
  const paired = connectorType === "wallet_connect" || connectorType === "wallet_connect_v2";
  if (chainType === "solana" && (paired || connectorType === "solana_adapter" || walletClientType === "walletconnect_solana")) return "wallet_connect_qr_solana";
  if (chainType !== "ethereum") return null;
  if (paired) return "wallet_connect_qr";
  if (connectorType === "coinbase_wallet" || connectorType === "base_account") return connectorType;
  return null;
}

/** Restore the user's paired or dedicated wallet without initializing other mobile connectors. */
export function useRestorePrivyWallet(wallet?: SavedWallet) {
  const enable = useContext(EnableWallets);
  const option = savedWalletOption(wallet);
  useEffect(() => {
    enable?.(option);
  }, [enable, option]);
}
