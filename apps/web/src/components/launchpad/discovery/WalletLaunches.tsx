"use client";

import { shortAddress as shortId } from "@blast/core/lib/format.ts";
import { Button, ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { useCallback, useEffect, useRef, useState } from "react";

import theme from "../primitives/LaunchpadTheme.module.css";
import type { SectionState } from "../primitives/data-state";
import { DiscoveryList } from "./DiscoveryList";
import { afterFirstPage, afterNextPage, type ViewList } from "./discovery-model";
import { readWalletLaunchesPage } from "./wallet-launches-client";
import styles from "./WalletLaunches.module.css";

type Read = typeof readWalletLaunchesPage;

const LOADING: SectionState<ViewList> = { status: "loading" };
const noView = () => {};

/** One wallet's launches: the first page on mount, then more on request. */
function WalletList({ address, heading, read }: Readonly<{ address: string; heading: boolean; read: Read }>) {
  const [state, setState] = useState(LOADING);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const ticket = useRef(0);
  const load = useCallback((cursor: string | null, mode: "refresh" | "more") => {
    const mine = ++ticket.current;
    if (mode === "refresh") setRefreshing(true);
    if (mode === "more") setLoadingMore(true);
    return read(address, cursor).then(answer => {
      if (mine === ticket.current) setState(previous => mode === "more" ? afterNextPage(previous, answer) : afterFirstPage(previous, answer));
    }).catch(() => {
      if (mine === ticket.current) setState(previous => mode === "more" ? afterNextPage(previous, null) : afterFirstPage(previous, null));
    }).finally(() => {
      if (mine === ticket.current) {
        setRefreshing(false);
        setLoadingMore(false);
      }
    });
  }, [address, read]);

  useEffect(() => {
    const mine = ++ticket.current;
    void read(address, null).catch(() => null).then(answer => {
      if (mine === ticket.current) setState(previous => afterFirstPage(previous, answer));
    }).finally(() => {
      if (mine === ticket.current) {
        setRefreshing(false);
        setLoadingMore(false);
      }
    });
    return () => { ticket.current += 1; };
  }, [address, read]);

  const refresh = () => load(null, "refresh");
  const more = () => {
    const cursor = state.status === "ready" || state.status === "stale" ? state.value.nextCursor : null;
    if (cursor) return load(cursor, "more");
  };

  return (
    <section className={styles.wallet} aria-label={heading ? `Launches created with wallet ${address}` : "Launches you created"}>
      {heading ? (
        <h3 className={styles.heading}>
          Created with{" "}
          <span aria-hidden="true" title={address}>
            {shortId(address)}
          </span>
          <span className="sr-only">wallet {address}</span>
        </h3>
      ) : null}
      {state.status === "unavailable" || state.status === "stale" ? (
        <Button
          className={styles.refresh}
          disabled={loadingMore}
          loading={refreshing}
          loadingLabel="Refreshing launches"
          onClick={() => void refresh()}
          size="sm"
          variant="ghost"
        >
          Refresh
        </Button>
      ) : null}
      {state.status === "empty" ? <EmptyState
        action={heading ? undefined : <ButtonLink href="/launch" size="sm">Launch a coin</ButtonLink>}
        title={heading ? "No launches for this wallet yet" : "No launches yet"}
      /> : <DiscoveryList
        view="new"
        state={state}
        selectedLaunchId={null}
        loadingMore={loadingMore}
        onLoadMore={() => void more()}
        onShowView={noView}
      />}
    </section>
  );
}

/**
 * The launches a reader created, with each of their linked wallets: the discovery views' own
 * rows, newest first, each linking to its coin. A wallet is a list of its own, under its address
 * when the reader links more than one. Read in the browser, the reader's own: never in the
 * server's HTML.
 */
export function WalletLaunches({ addresses, read = readWalletLaunchesPage }: Readonly<{ addresses: readonly string[]; read?: Read }>) {
  return (
    <div data-launchpad-theme="" className={`${theme.theme} ${styles.launches}`}>
      {addresses.length !== 1 ? <EmptyState
        action={<ButtonLink href="/launch" size="sm">Launch a coin</ButtonLink>}
        compact
        row
        title={addresses.length === 0 ? "No launches yet" : "Your linked wallets"}
      /> : null}
      {addresses.map((address) => (
        <WalletList key={address} address={address} heading={addresses.length > 1} read={read} />
      ))}
    </div>
  );
}
