import { isValidSuiAddress } from "@mysten/sui/utils";
import { SOCIAL_TRADE_MAX_SLIPPAGE_BPS, SOCIAL_TRADE_MIN_SLIPPAGE_BPS } from "@blast/core/web/contracts/trades.ts";

import { switchAccountSession, type AccountSession } from "../account-selection";
import { saveSignInDraft, takeSignInDraft, useSignInDraft } from "../sign-in-draft";
import { parseSavedCoinScreen, type CoinOpening, type CoinScreen, type WalletCoinView } from "./coin-model";
import { decodeTradeAction, encodeTradeAction, tradableCoinView } from "./swap-model";

export type WalletActionDraft = Readonly<{ amount: string; recipient?: string; detail?: boolean; slippageBps?: number; address: string }>;
export type WalletActionInput = Omit<WalletActionDraft, "address"> & Readonly<{ screen: CoinScreen; coins: readonly WalletCoinView[] }>;

function key(surface: string, session: AccountSession) {
  return `wallet-action:${surface}:${session}`;
}

/** The reload gets only unsigned inputs and public coin descriptors. */
export function switchWithWalletDraft(surface: string, session: AccountSession, address: string, input: WalletActionInput): boolean {
  try {
    const storage = window.sessionStorage;
    const path = window.location.pathname;
    const draftKey = key(surface, session);
    const saved = saveSignInDraft(storage, draftKey, path, {
      address,
      screen: JSON.stringify(input.screen),
      coins: JSON.stringify(input.coins.map(coin => [coin.key, encodeTradeAction({ side: "buy", coin: {
        coin_type: coin.coinType, name: coin.name, symbol: coin.symbol, decimals: coin.decimals,
        icon_url: coin.iconUrl, usd_price: null, presale_id: coin.presale?.presaleId ?? null,
      } })])),
      amount: input.amount,
      recipient: input.recipient ?? "",
      detail: String(input.detail ?? false),
      slippageBps: String(input.slippageBps ?? ""),
    });
    if (!saved) return false;
    if (switchAccountSession(session)) return true;
    takeSignInDraft(storage, draftKey, path);
    return false;
  } catch {
    return false;
  }
}

export function useWalletActionDraft(surface: string, session: AccountSession, restore: (opening: CoinOpening) => void, enabled: boolean) {
  useSignInDraft(key(surface, session), null, saved => {
    const screen = parseSavedCoinScreen(saved.screen);
    if (!screen || (screen.kind !== "trade" && screen.kind !== "wd") || !saved.address || !isValidSuiAddress(saved.address)) return;
    try {
      const encoded: unknown = JSON.parse(saved.coins ?? "");
      if (!Array.isArray(encoded) || encoded.length > 2) return;
      const coins: WalletCoinView[] = [];
      for (const entry of encoded) {
        if (!Array.isArray(entry) || entry.length !== 2) return;
        const [key, encodedAction] = entry;
        if (typeof key !== "string" || typeof encodedAction !== "string") return;
        const action = decodeTradeAction(encodedAction);
        if (!action) return;
        coins.push({ ...tradableCoinView(action.coin), key });
      }
      const slippage = Number(saved.slippageBps);
      const slippageBps = Number.isInteger(slippage) && slippage >= SOCIAL_TRADE_MIN_SLIPPAGE_BPS && slippage <= SOCIAL_TRADE_MAX_SLIPPAGE_BPS ? slippage : undefined;
      restore({ screen, coins, walletDraft: { address: saved.address, amount: saved.amount ?? "", recipient: saved.recipient, detail: saved.detail === "true", slippageBps } });
    } catch { /* Ignore an unreadable draft. */ }
  }, enabled);
}
