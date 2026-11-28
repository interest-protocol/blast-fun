"use client";

import { Switch } from "./Switch";

import { diagnosticMessage } from "#web/lib/errors.ts";

import clsx from "clsx";
import { useEffect, useRef, type ReactNode } from "react";

import { EXPLORER_NAMES } from "@blast/core/lib/explorer.ts";
import { usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import { Button, DisclosureSummary } from "#web/components/blast-ui/Button.tsx";
import { ServiceStatus } from "#web/components/blast-ui/ServiceStatus.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { SelectField } from "#web/components/blast-ui/TextField.tsx";
import { ThemeControl } from "#web/components/blast-ui/ThemeControl.tsx";
import type { SocialAccountWallet } from "@blast/core/web/contracts/me.ts";
import { SOCIAL_EXPLORERS, type NotificationPreferenceKey, type SocialExplorer, type SocialSettingsResponse } from "@blast/core/web/contracts/settings.ts";

import styles from "./SettingsView.module.css";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { CopyButton } from "#web/components/blast-ui/CopyButton.tsx";
import { coinTypeName } from "../coins/coin-model";
import { AddIcon, ChevronIcon, WalletIcon } from "./settings-icons";
import { COPY, LINK_WALLET_BUTTON_ID, NOTIFICATION_ROWS, shortWallet, walletName, walletRows, walletSince } from "./settings-model";

/**
 * Settings (FEATURE-MAP §7) as the Settings board draws it: Appearance (theme), Notifications (eight switches), Transactions, Privacy with its
 * footnote, Wallets and Account. Presentational:
 * the screen (`SettingsScreen`) owns the data and the saves, and the
 * development fixture renders the same view with the design's sample account.
 *
 * - `account`: a signed-in account with its stored settings; every group.
 * - `loading`: the account or its settings are being read; the groups keep
 *   their shape and the controls wait (`aria-busy`).
 * - `error`: they could not be read; device settings stay usable and a retry
 *   is offered.
 * - `visitor` (signed out) and `no-account` (signed in, no Blast Account):
 *   all groups stay visible; account actions ask the visitor to sign in.
 */
export type SettingsMode = "account" | "loading" | "error" | "visitor" | "no-account";

export type SettingsViewProps = Readonly<{
  mode: SettingsMode;
  errorMessage?: string;
  /** The stored settings as shown (with any change not yet confirmed). Required in `account` mode. */
  settings: SocialSettingsResponse | null;
  /** The account's wallets (`me.wallets`). */
  wallets: readonly SocialAccountWallet[];
  callsign: string | null;
  celebrate: boolean;
  /** This device's followed buy cards (`buyAlerts`). */
  buyAlerts: boolean;
  /** The explorer shown: the account's in `account` mode, else this device's. */
  explorer: SocialExplorer;
  /** The coins a hold may pay with: the wallet's held coins once read. */
  holdCoins?: readonly Readonly<{ coinType: string; symbol: string }>[] | "pending" | "error";
  /** Null is each sale's own coin. */
  onHoldCoin?(coinType: string | null): void;
  onNotification(key: NotificationPreferenceKey, on: boolean): void;
  onCelebrate(on: boolean): void;
  onBuyAlerts(on: boolean): void;
  onBlastConfirmation(on: boolean): void;
  onPrivate(on: boolean): void;
  onPublicPortfolio(on: boolean): void;
  onExplorer(explorer: SocialExplorer): void;
  onCopy(wallet: SocialAccountWallet): boolean | void | Promise<boolean | void>;
  onLinkWallet(): void;
  onUnlinkWallet?(wallet: SocialAccountWallet): void;
  onLogOut(): void;
  onSignIn(): void;
  onRetry(): void;
  /** Whether a log-out is running (its row waits). */
  loggingOut?: boolean;
}>;

function Group({ id, title, children, note }: Readonly<{ id: string; title: string; children: ReactNode; note?: string }>) {
  const phone = usePhoneLayout();
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!phone) return;
    function openLinkedGroup() {
      if (!disclosure.current || window.location.hash !== `#${id}`) return;
      disclosure.current.open = true;
    }
    openLinkedGroup();
    window.addEventListener("hashchange", openLinkedGroup);
    return () => window.removeEventListener("hashchange", openLinkedGroup);
  }, [id, phone]);

  const content = (
    <>
      <div className={clsx("card", styles.box)} data-surface="">
        {children}
      </div>
      {note ? <p className={styles.note}>{note}</p> : null}
    </>
  );
  return (
    <section aria-labelledby={phone ? undefined : id} className={styles.group}>
      {phone ? (
        <details className={styles.disclosure} id={id} ref={disclosure}>
          <DisclosureSummary>{title}</DisclosureSummary>
          {content}
        </details>
      ) : (
        <>
          <h2 className={styles.label} id={id}>{title}</h2>
          {content}
        </>
      )}
    </section>
  );
}

function Text({ title, sub, danger = false }: Readonly<{ title: string; sub?: ReactNode; danger?: boolean }>) {
  return (
    <span className={styles.text}>
      <b className={danger ? styles.danger : undefined}>{title}</b>
      {sub === undefined ? null : <span>{sub}</span>}
    </span>
  );
}

/** A switch row: 60px under Appearance and Notifications, 68px (`tall`) where a line sits under the title. */
function SwitchRow(props: Readonly<{ title: string; sub?: string; on: boolean | null; onChange(on: boolean): void; busy: boolean; disabled?: boolean; tall?: boolean }>) {
  return (
    <div className={clsx(styles.row, props.tall && styles.tall)}>
      <Text sub={props.sub} title={props.title} />
      {props.busy ? <SkeletonText>Loading</SkeletonText> : props.on === null ? <span className={styles.unavailable}>Unavailable</span> : <Switch busy={false} disabled={props.disabled} label={props.title} on={props.on} onChange={props.onChange} />}
    </div>
  );
}

/** The hold's pay coin: each sale's own coin, or one this wallet holds (the stored one stays listed when it is no longer held). */
function HoldCoinControl({ value, coins, onChange }: Readonly<{ value: string | null; coins: readonly Readonly<{ coinType: string; symbol: string }>[]; onChange(coinType: string | null): void }>) {
  const listed = value === null || coins.some((coin) => coin.coinType === value) ? coins : [...coins, { coinType: value, symbol: coinTypeName(value) }];
  return (
    <SelectField
      aria-label={COPY.holdCoin.label}
      className={styles.explorer}
      onChange={(event) => {
        const next = event.currentTarget.value || null;
        if (next !== value) onChange(next);
      }}
      value={value ?? ""}
    >
      <option value="">{COPY.holdCoin.sale}</option>
      {listed.map((coin) => <option key={coin.coinType} value={coin.coinType}>{coin.symbol}</option>)}
    </SelectField>
  );
}

/** Explorer: the shared select of the supported explorers. */
function ExplorerControl({ value, onChange }: Readonly<{ value: SocialExplorer; onChange(explorer: SocialExplorer): void }>) {
  return (
    <SelectField
      aria-label="Explorer"
      className={styles.explorer}
      onChange={(event) => {
        const next = SOCIAL_EXPLORERS.find((explorer) => explorer === event.currentTarget.value);
        if (next && next !== value) onChange(next);
      }}
      value={value}
    >
      {SOCIAL_EXPLORERS.map((explorer) => <option key={explorer} value={explorer}>{EXPLORER_NAMES[explorer]}</option>)}
    </SelectField>
  );
}

function WalletRow({ wallet, onCopy, onUnlink }: Readonly<{
  wallet: SocialAccountWallet;
  onCopy(wallet: SocialAccountWallet): boolean | void | Promise<boolean | void>;
  onUnlink?: SettingsViewProps["onUnlinkWallet"];
}>) {
  const name = walletName(wallet.kind);
  return (
    <div className={clsx(styles.row, styles.tall, styles.wallet)}>
      <span aria-hidden="true" className={styles.walletIcon}>
        <WalletIcon />
      </span>
      <span className={styles.text}>
        <b>{name}</b>
        <InspectValue label={`${name} address · ${walletSince(wallet)}`} value={wallet.address}>{shortWallet(wallet.address)}</InspectValue>
      </span>
      <div className={styles.walletActions}>
        <CopyButton label={`Copy ${name} address`} onCopy={() => onCopy(wallet)} size="md" />
        {wallet.kind === "slush" && onUnlink ? (
          <Button aria-label={`Unlink Slush wallet ${shortWallet(wallet.address)}`} size="md" variant="ghost" onClick={() => onUnlink(wallet)}>
            Unlink
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function PrivacySettings({ props, busy }: Readonly<{ props: SettingsViewProps; busy: boolean }>) {
  const settings = props.settings;
  const disabled = !props.callsign && props.mode !== "visitor";
  return (
    <Group id="settings-privacy" note={COPY.privacyNote} title="Privacy">
      <SwitchRow
        busy={busy}
        disabled={disabled}
        on={props.mode === "error" ? null : settings?.public_portfolio ?? false}
        onChange={props.onPublicPortfolio}
        sub={props.mode === "error" ? "Your portfolio visibility could not load." : settings?.public_portfolio ? COPY.publicPortfolio.on : COPY.publicPortfolio.off}
        tall
        title={COPY.publicPortfolio.title}
      />
      <SwitchRow
        busy={busy}
        disabled={disabled}
        on={props.mode === "error" ? null : settings?.privacy === "private"}
        onChange={props.onPrivate}
        sub={props.mode === "error" ? "Your privacy preference could not load." : settings?.privacy === "private" ? COPY.private.on : COPY.private.off}
        tall
        title={COPY.private.title}
      />
    </Group>
  );
}

export function SettingsView(input: SettingsViewProps) {
  let props = input;
  const { mode } = props;
  const unavailable = mode === "visitor" || mode === "no-account";
  const settings = unavailable ? null : props.settings;
  const busy = mode === "loading";
  const visitor = mode === "visitor";
  if (unavailable) props = { ...props, settings: null, wallets: [], callsign: null };
  if (visitor) props = {
    ...props,
    onNotification: props.onSignIn,
    onPrivate: props.onSignIn,
    onPublicPortfolio: props.onSignIn,
    onLinkWallet: props.onSignIn,
  };

  return (
    // `data-surface`: the right column's card lines up with the top of this column, as the board draws it;
    // `data-shell-aside="settings"`: the board's 336px "Your wallet" column.
    <div aria-busy={busy || undefined} className={styles.set} data-shell-aside="settings" data-surface="">
      <Group id="settings-appearance" title="Appearance">
        <div className={styles.row}>
          <Text title={COPY.theme.title} />
          <ThemeControl />
        </div>
      </Group>

      <Group id="settings-notifications" title="Notifications">
        {NOTIFICATION_ROWS.map((row) => (
          <SwitchRow
            busy={busy}
            key={row.key}
            on={mode === "error" ? null : settings?.notifications[row.key] ?? true}
            onChange={(on) => props.onNotification(row.key, on)}
            title={row.title}
          />
        ))}
        <SwitchRow
          busy={false}
          on={props.celebrate}
          onChange={props.onCelebrate}
          title={COPY.celebrations.title}
        />
        <SwitchRow
          busy={false}
          on={props.buyAlerts}
          onChange={props.onBuyAlerts}
          title={COPY.buyAlerts.title}
        />
      </Group>

      <TransactionSettings props={props} busy={busy} />

      <PrivacySettings busy={busy} props={props} />

      <WalletSettings props={props} busy={busy} />

      {mode === "error" ? (
        <EmptyState action={<Button onClick={props.onRetry} size="sm">Try again</Button>} framed role="alert" title={<>Your settings couldn&rsquo;t load</>}>
          {props.errorMessage ?? diagnosticMessage("Nothing was changed. Check your connection, then try again.")}
        </EmptyState>
      ) : null}

      <Group id="settings-account" title="Account">
        {mode === "visitor" ? (
          <button className={clsx(styles.row, styles.action)} onClick={props.onSignIn} type="button">
            <Text title={COPY.signIn.title} />
            <ChevronIcon className={styles.chev} />
          </button>
        ) : (
          <button
            aria-busy={props.loggingOut || undefined}
            aria-label={props.callsign ? `Log out @${props.callsign}` : undefined}
            className={clsx(styles.row, styles.action, styles.dangerRow)}
            disabled={busy || props.loggingOut}
            onClick={props.onLogOut}
            type="button"
          >
            <Text danger title={COPY.logOut.title} />
          </button>
        )}
      </Group>
      <ServiceStatus navigation />
    </div>
  );
}

function TransactionSettings({ props, busy }: Readonly<{ props: SettingsViewProps; busy: boolean }>) {
  return (
    <Group id="settings-transactions" title="Transactions">
      <div className={clsx(styles.row, styles.tall)}>
        <Text title={COPY.holdCoin.title} />
        {busy ? <span aria-hidden="true" className={clsx(styles.skeleton, styles.fieldSize)} /> : (
          <AccountOnly props={props}>
            {(settings) => props.holdCoins === "pending" ? <span aria-hidden="true" className={clsx(styles.skeleton, styles.fieldSize)} />
              : props.holdCoins === "error" ? <span className={styles.unavailable}>Unavailable</span>
              : <HoldCoinControl coins={props.holdCoins ?? []} onChange={(coinType) => props.onHoldCoin?.(coinType)} value={settings.commit_too_coin_type} />}
          </AccountOnly>
        )}
      </div>
      <div className={clsx(styles.row, styles.tall)}>
        <Text title={COPY.explorer.title} />
        {busy ? (
          <span aria-hidden="true" className={clsx(styles.skeleton, styles.fieldSize)} />
        ) : (
          <ExplorerControl onChange={props.onExplorer} value={props.explorer} />
        )}
      </div>
      <div className={clsx(styles.row, styles.tall)}>
        <Text sub={COPY.confirmTrades.sub} title={COPY.confirmTrades.title} />
        {busy ? <span aria-hidden="true" className={clsx(styles.skeleton, styles.switchSize)} /> : (
          <AccountOnly props={props}>
            {(settings) => <Switch label={COPY.confirmTrades.title} on={settings.blast_mode_confirm_actions} onChange={props.onBlastConfirmation} busy={false} />}
          </AccountOnly>
        )}
      </div>
    </Group>
  );
}

/** An account-stored setting: its control once read, sign-in for a visitor, else unavailable. */
function AccountOnly({ props, children }: Readonly<{ props: SettingsViewProps; children: (settings: SocialSettingsResponse) => ReactNode }>) {
  if (props.mode === "account" && props.settings) return children(props.settings);
  if (props.mode === "visitor" || props.mode === "no-account") return <Button onClick={props.onSignIn} size="sm" variant="ghost">Sign in</Button>;
  return <span className={styles.unavailable}>Unavailable</span>;
}

function WalletSettings({ props, busy }: Readonly<{ props: SettingsViewProps; busy: boolean }>) {
  return (
    <Group id="settings-wallets" title="Wallets">
      {busy ? (
        <div className={clsx(styles.row, styles.tall, styles.wallet)}>
          <span aria-hidden="true" className={styles.walletIcon}>
            <WalletIcon />
          </span>
          <span className={styles.text}>
            <b>{walletName("embedded")}</b>
            <span aria-hidden="true" className={clsx(styles.skeleton, styles.line)} />
          </span>
        </div>
      ) : (
        walletRows(props.wallets).map((wallet) => (
          <WalletRow key={wallet.address} onCopy={props.onCopy} onUnlink={props.mode === "account" ? props.onUnlinkWallet : undefined} wallet={wallet} />
        ))
      )}
      <button className={clsx(styles.row, styles.tall, styles.wallet, styles.action)} disabled={busy} id={LINK_WALLET_BUTTON_ID} onClick={props.onLinkWallet} type="button">
        <span aria-hidden="true" className={styles.walletIcon}>
          <AddIcon />
        </span>
        <Text title={COPY.link.title} />
      </button>
    </Group>
  );
}
