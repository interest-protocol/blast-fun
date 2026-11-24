"use client";
import { hoverExcerpt } from "#web/lib/hover-text.ts";
import { Button, DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { useContext, useId, type ReactNode } from "react";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { createPortal } from "react-dom";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { CopyButton } from "#web/components/blast-ui/CopyButton.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import styles from "./PanelChrome.module.css";

import { PanelHeadingContext, PanelAssetContext } from "./panel-context";
import { coinTypeIdentity, useReportPanelIdentity } from "../panel-identities";

const ICON_PATHS: Record<string, string> = {
  overview: "M3 17l5-5 4 3 8-10M15 5h5v5",
  activity: "M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4",
  people:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  posts: "M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5M8 9h8M8 13h5",
  sale: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  commits: "M12 3v11m-4-4 4 4 4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  restore: "M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5",
  expand: "M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5",
};

export function PanelIcon({ name }: Readonly<{ name: string }>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name] ?? ICON_PATHS.overview} />
    </svg>
  );
}

/** Where a coin trades, with the venue's logo; a plain stage when the venue is not known. */
export function TradingStage({ venue, label = "Trading" }: Readonly<{ venue?: string | null; label?: string }>) {
  return (
    <span className={styles.stageLine}>
      {venue ? (
        <>
          <span className={styles.tradingLead}>{label} on </span>
          <strong><DexIdentity iconOnly venue={venue} /></strong>
        </>
      ) : (
        label
      )}
    </span>
  );
}

/** A presale's phase with its clock, e.g. "Presale · closes in 4h 12m"; narrow cards keep only the time. */
export function SaleStage({ lead, children }: Readonly<{ lead?: string; children: ReactNode }>) {
  return (
    <span className={styles.stageLine}>
      <PanelIcon name="clock" />
      <span className={styles.stageText}>
        {lead ? <span className={styles.stageLead}>{lead} · </span> : null}
        {children}
      </span>
    </span>
  );
}

/**
 * The panel's identity row, portalled into the card header: the coin's tile,
 * symbol and name, its stage line, and the panel's view tabs on the right.
 */
export function PanelIdentity({
  coinType,
  stable = false,
  network = "mainnet",
  symbol,
  name,
  icon,
  verified = false,
  stage,
  tabs,
  metrics,
  socials,
}: Readonly<{
  coinType: string;
  stable?: boolean;
  network?: string;
  symbol?: string;
  name?: string;
  icon?: string | null;
  verified?: boolean;
  stage: ReactNode;
  tabs?: ReactNode;
  metrics?: ReactNode;
  socials?: ReactNode;
}>) {
  const select = useContext(PanelAssetContext);
  const target = useContext(PanelHeadingContext);
  const stageId = useId();
  const label = symbol ?? coinTypeIdentity(coinType).symbol;
  useReportPanelIdentity(coinType, symbol, icon, name, network);
  const mark = <span className={styles.mark}>
    <CoinMark coin={{ key: coinType, coinType, symbol, iconUrl: icon ?? null, round: false }} size={34} />
  </span>;
  const symbolLine = <IdentitySymbol label={label} name={name} verified={verified} />;
  const identity = (
    <>
      {mark}
      <span className={styles.names}>
        {symbolLine}
        <span className={styles.stage} id={stageId}>{stage}</span>
        <span className={styles.chain}>Sui · {network} · <span className={styles.chainId}>{coinType.split("::")[0]!.slice(0, 6)}…{coinType.split("::")[0]!.slice(-6)}</span></span>
      </span>
    </>
  );
  const header = (
    <header className={styles.header} data-stable={stable}>
      {stable ? <CompactPanelIdentity mark={mark} symbolLine={symbolLine} select={select} label={label} name={name} stageId={stageId} stage={stage} network={network} coinType={coinType} socials={socials} /> : select ? (
        <DisclosureButton variant="ghost" size="sm"
          type="button"
          className={styles.selector}
          onClick={select}
          aria-label={`Select coin for ${label} panel`}
          aria-describedby={stageId}
          title={hoverExcerpt(`${label}${name ? ` · ${name}` : ""}`)}
        >
          {identity}
        </DisclosureButton>
      ) : (
        <div className={styles.selector}>{identity}</div>
      )}
      {metrics && <div className={styles.metrics}>{metrics}</div>}
      {tabs ? <div className={styles.tabsSlot}>{tabs}</div> : null}
    </header>
  );
  return target ? createPortal(header, target) : header;
}

function IdentitySymbol({ label, name, verified }: Readonly<{ label: string; name?: string; verified: boolean }>) {
  return <span className={styles.symbolLine}>
    <strong>{label}</strong>
    {verified ? <CoinVerifiedMark size="md" /> : null}
    {name && name !== label ? <span className={styles.name}>{name}</span> : null}
  </span>;
}

/** Keep contract inspection independent of the asset selector and its touch target. */
function CompactPanelIdentity({ mark, symbolLine, select, label, name, stageId, stage, network, coinType, socials }: Readonly<{
  mark: ReactNode; symbolLine: ReactNode; select: (() => void) | null; label: string; name?: string;
  stageId: string; stage: ReactNode; network: string; coinType: string; socials?: ReactNode;
}>) {
  const address = coinType.split("::")[0]!;
  return <div className={styles.compactIdentity}>
    {mark}
    <div className={styles.names}>
      <div className={styles.identityTitle}>
        {select ? <DisclosureButton variant="ghost" size="sm" className={styles.selector} type="button" onClick={select} aria-label={`Select coin for ${label} panel`} aria-describedby={stageId} title={hoverExcerpt(`${label}${name ? ` · ${name}` : ""}`)}>{symbolLine}</DisclosureButton> : symbolLine}
        {socials}
      </div>
      <div className={styles.identityMeta}>
        <span className={styles.stage} id={stageId}>{stage}</span>
        {network !== "mainnet" && <strong className={styles.network}>{network}</strong>}
        <span className={styles.contract}>
          <InspectValue label={`coin type on Sui ${network}`} value={coinType}>{address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address}</InspectValue>
          <CopyButton key={coinType} className={styles.copy} label={`Copy ${label} coin address`} onCopy={async () => { await navigator.clipboard.writeText(coinType); return true; }} />
        </span>
      </div>
    </div>
  </div>;
}

export type PanelTab<T extends string> = readonly [value: T, label: string, icon: string];

/**
 * A panel's views as one segmented control. Every tab shows its icon; the
 * selected one also shows its word, and each keeps its name for assistive
 * technology and as a tooltip. Arrow keys, Home and End move between tabs.
 */
export function PanelTabs<T extends string>({
  tabs,
  selected,
  onSelect,
  prefix,
  label,
}: Readonly<{
  tabs: readonly PanelTab<T>[];
  selected: T | null;
  onSelect: (tab: T) => void;
  prefix: string;
  label: string;
}>) {
  return (
    <div role="tablist" aria-label={label} className={styles.tabs}>
      {tabs.map(([tab, text, icon], index) => (
        <Button variant="segment" size="sm"
          className={styles.tab}
          data-tab={tab}
          key={tab}
          id={`${prefix}-${tab}`}
          type="button"
          role="tab"
          aria-label={text}
          aria-selected={selected === tab}
          tabIndex={selected === tab ? 0 : -1}
          aria-controls={`${prefix}-content`}
          title={text}
          onKeyDown={(event) => {
            const next = {
              Home: 0,
              End: tabs.length - 1,
              ArrowRight: (index + 1) % tabs.length,
              ArrowLeft: (index + tabs.length - 1) % tabs.length,
            }[event.key];
            if (next === undefined) return;
            event.preventDefault();
            const value = tabs[next]![0];
            onSelect(value);
            document.getElementById(`${prefix}-${value}`)?.focus();
          }}
          onClick={() => onSelect(tab)}
        >
          <PanelIcon name={icon} />
          <span className={styles.tabLabel} aria-hidden="true">{text}</span>
        </Button>
      ))}
    </div>
  );
}

/** Secondary facts beside the headline figure: a short label over its value. */
export function PanelStats({
  items,
}: Readonly<{
  items: readonly Readonly<{ label: string; value: ReactNode }>[];
}>) {
  const hidden = useShellPrefs().amountsHidden;
  return (
    <dl className={styles.stats}>
      {items.map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{hidden ? "••••" : (value ?? "—")}</dd>
        </div>
      ))}
    </dl>
  );
}
