"use client";

import { isSmallBalance } from "@blast/core/modules/social/portfolio/small-balance.ts";
import { diagnosticMessage } from "#web/lib/errors.ts";

import clsx from "clsx";

import { HIDDEN_AMOUNT, usd } from "@blast/core/web/format.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";

import type { WalletCoinView } from "../coins/coin-model";
import { livePins, pinSort, useCoinPins } from "../coins/coin-pins";
import { CoinRow } from "../coins/SideCoins";
import { useWalletCoins } from "../coins/use-wallet";
import { useSocialViewer } from "../SignInGate";
import { ArrowDownIcon, ArrowUpIcon } from "#web/components/blast-ui/Icons.tsx";
import styles from "./WalletCard.module.css";

/**
 * "Your wallet" (the settings page's right column, the Settings board): the
 * title, the wallet's total in the display face, the two coins you blast
 * with — USDC and SUI — as the shared coin rows (a tonal row each, 6px apart;
 * a row opens that coin), then Deposit and Withdraw. R3-33: no address row
 * (the address lives in Wallets on the same page). `coins` null is loading;
 * `hidden` (the privacy eye) masks every amount; `value` is the wallet's total
 * from the same read, omitted while a holding has no price (null).
 */
export function WalletCardView({
  coins,
  value = null,
  failed = false,
  errorMessage,
  unavailable = false,
  hidden,
  pins,
  onOpen,
  onRetry,
  onDeposit,
  onWithdraw,
}: Readonly<{
  coins: readonly WalletCoinView[] | null;
  value?: number | null;
  failed?: boolean;
  errorMessage?: string;
  unavailable?: boolean;
  hidden: boolean;
  pins: readonly string[];
  onOpen(key: string): void;
  onRetry?(): void;
  onDeposit(): void;
  onWithdraw(): void;
}>) {
  const ready = !unavailable && !failed && coins !== null;
  return (
    <div aria-busy={coins === null || undefined} className={clsx("card", styles.card)} data-aside-card="" id="sideWallet">
      <h2 className={styles.title}>Your wallet</h2>
      {ready && value !== null ? <span className={clsx("num", styles.total)}>{hidden ? HIDDEN_AMOUNT : usd(value, 2)}</span> : null}
      {unavailable ? <p className={styles.empty}>Sign in to see your balances.</p> : failed ? (
        <div className={styles.failed}>
          <p className={styles.empty} role="alert">{errorMessage ?? diagnosticMessage("Your wallet could not load. Nothing changed.", { code: "service_unavailable" })}</p>
          {onRetry ? <Button onClick={onRetry} size="sm">Try again</Button> : null}
        </div>
      ) : <WalletRows coins={coins} hidden={hidden} onOpen={onOpen} pins={pins} />}
      <div className={styles.actions}>
        <Button onClick={onDeposit} variant="primary">
          <ArrowDownIcon />
          Deposit
        </Button>
        <Button onClick={onWithdraw}>
          <ArrowUpIcon />
          Withdraw
        </Button>
      </div>
    </div>
  );
}

/** The two coin rows, 6px apart; their place while the read runs; a note when small balances hide both. */
function WalletRows({ coins, hidden, pins, onOpen }: Readonly<{ coins: readonly WalletCoinView[] | null; hidden: boolean; pins: readonly string[]; onOpen(key: string): void }>) {
  const { hideSmallBalances } = useShellPrefs();
  if (coins === null)
    return (
      <div aria-hidden="true" className={styles.rows}>
        <span className={styles.pulse} />
        <span className={styles.pulse} />
      </div>
    );
  const pay = paymentCoins(coins, pins, hideSmallBalances);
  if (pay.length === 0) return <p className={styles.empty}>Small balances hidden.</p>;
  return (
    <div className={styles.rows}>
      {pay.map((coin) => <CoinRow coin={coin} hidden={hidden} key={coin.key} onOpen={() => onOpen(coin.key)} />)}
    </div>
  );
}

/**
 * The settings page's right column (≥1220 px): "Your wallet" for a signed-in
 * account, with unavailable balances for a visitor. The coins and the total are the Blast wallet's own read
 * (`GET /api/social/me/wallet`, the same read as Home's "Your coins"), read
 * after hydration and again when the balances move; a row opens that coin's
 * sheet, Deposit and Withdraw open the shell's sheets.
 */
export function SettingsWalletCard() {
  const viewer = useSocialViewer();
  const { amountsHidden } = useShellPrefs();
  const run = useShellActions();
  const pins = useCoinPins();
  const read = useWalletCoins();
  return (
    <WalletCardView
      coins={viewer.signedIn && read.status === "ready" ? read.coins : viewer.sessionPending ? null : []}
      value={viewer.signedIn && read.status === "ready" ? read.value ?? null : null}
      unavailable={!viewer.signedIn && !viewer.sessionPending}
      failed={viewer.signedIn && read.status === "error"}
      errorMessage={read.message}
      hidden={amountsHidden}
      onDeposit={() => run("openDeposit")}
      onOpen={(key) => run("openCoin", key)}
      onRetry={read.retry}
      onWithdraw={() => run("openWithdraw")}
      pins={pins}
    />
  );
}

function paymentCoins(coins: readonly WalletCoinView[] | null, pins: readonly string[], hideSmall: boolean) {
  if (coins === null) return [];
  return pinSort(coins, livePins(pins, coins)).filter(coin => (coin.key === "usdc" || coin.key === "sui") && (!hideSmall || !isSmallBalance(coin.atoms, coin.metadataAvailable === false ? null : coin.decimals, coin.coinType)));
}
