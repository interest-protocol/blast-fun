"use client";

import { useState } from "react";
import { AppShell } from "#web/components/blast-ui/AppShell.tsx";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { useShellAction } from "#web/components/blast-ui/shell-actions.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { CoinSheet, type CoinSheetTrading, type CoinSheetWallet } from "#web/components/social/coins/CoinSheet.tsx";
import { coinView, type CoinScreen } from "#web/components/social/coins/coin-model.ts";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { bricolage, geist, geistMono } from "#web/components/blast-ui/fonts.ts";
import { setShellPref } from "#web/components/blast-ui/use-shell-prefs.ts";
import { FIXTURE_COINS, FIXTURE_WALLET_ADDRESS } from "../../../social/coins/coins-fixture-model.ts";

const coins = [...FIXTURE_COINS.map(coin => ({ ...coin, iconUrl: null })), ...Array.from({ length: 22 }, (_, index) => coinView({
  coin_type: `0x${(index + 100).toString(16).padStart(64, "0")}::coin::DEMO${index}`,
  symbol: `DEMO${index}`, name: index === 0 ? "An unusually long coin name that must stay inside its row" : `Demo coin ${index + 1}`,
  decimals: 9, atoms: "1234500000000", usd_price: null, value_usd: null, icon_url: null, presale: null,
}))];
const trading: CoinSheetTrading = {
  signedIn: true, onSignIn: () => undefined, listCoins: async () => [],
  requestQuote: async () => { throw new Error("Quotes are outside this fixture"); },
  trade: async () => { throw new Error("Transactions are outside this fixture"); },
};

const viewer = { accountId: "fixture", callsign: "fixture", displayName: "Fixture account", avatarUrl: null, verified: false };

function FundOpener({ onFund }: Readonly<{ onFund: () => void }>) {
  useShellAction("openFund", onFund);
  return null;
}

/** Production shell and modal with synthetic holdings only; no wallet or transaction access. */
export default function DepositProof() {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const [theme, setTheme] = useState("dark");
  const [first, setFirst] = useState<CoinScreen>({ kind: "fund" });
  const [wallet, setWallet] = useState<CoinSheetWallet>({ status: "ready", address: FIXTURE_WALLET_ADDRESS, fee: "sponsored", coins });
  const show = (next: CoinScreen, state: "ready" | "loading" | "error" | "empty" = "ready") => {
    setFirst(next);
    setWallet(state === "ready" || state === "empty" ? { status: "ready", address: FIXTURE_WALLET_ADDRESS, fee: "sponsored", coins: state === "empty" ? [] : coins } : { status: state });
    setSession(value => value + 1);
    setOpen(true);
  };
  return <QueryProvider><div className={`${bricolage.variable} ${geist.variable} ${geistMono.variable}`} data-blast-ui="" data-theme={theme} style={{ minHeight: "100dvh", padding: "2rem" }}>
    <AppShell
      overlays={<FundOpener onFund={() => show({ kind: "fund" })} />}
      portfolio={{ status: "ready", summary: { total_usd: 3660.34, today: null } }}
      signInHref="/sign-in"
      signedIn
      viewer={viewer}
    >
      <PageHeader title="Wallet verification" />
      <Button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>Change theme</Button>
      <Button onClick={() => setShellPref("amountsHidden", true)}>Hide amounts</Button>
      <Button onClick={() => setShellPref("amountsHidden", false)}>Show amounts</Button>
      <Button onClick={() => show({ kind: "dep" })}>Open deposit</Button>
      <Button onClick={() => show({ kind: "pick", mode: "withdraw" })}>Open withdraw</Button>
      <Button onClick={() => show({ kind: "trade", key: "usdc" })}>Open swap</Button>
      <Button onClick={() => show({ kind: "fund" }, "loading")}>Pending wallet</Button>
      <Button onClick={() => show({ kind: "fund" }, "error")}>Failed wallet</Button>
      <Button onClick={() => show({ kind: "fund" }, "empty")}>Empty wallet</Button>
      <CoinSheet first={first} onClose={() => setOpen(false)} onCopy={async (address) => { await navigator.clipboard.writeText(address); return true; }} onRetry={() => setWallet({ status: "ready", address: FIXTURE_WALLET_ADDRESS, fee: "sponsored", coins })} onWithdraw={async () => false} open={open} session={session} trading={trading} wallet={wallet} />
    </AppShell>
  </div></QueryProvider>;
}
