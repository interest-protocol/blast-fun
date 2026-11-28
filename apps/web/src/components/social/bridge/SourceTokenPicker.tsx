"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";

import { Button, DisclosureButton, IconButton } from "#web/components/blast-ui/Button.tsx";
import { CopyAddress } from "#web/components/blast-ui/CopyAddress.tsx";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { CheckIcon, CloseIcon } from "#web/components/blast-ui/Icons.tsx";
import { Sheet, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { SkeletonLine } from "#web/components/blast-ui/Skeleton.tsx";
import { TextField } from "#web/components/blast-ui/TextField.tsx";
import { Ticker } from "#web/components/blast-ui/Ticker.tsx";
import { useDebouncedValue } from "#web/lib/use-debounced-value.ts";

import type { BridgeChain } from "./bridge-config.ts";
import { CHAINS, sourceAddressKey, TOKENS_FAILED_TEXT, type SourceToken } from "./bridge-model.ts";
import type { BridgeSdk } from "./bridge-sdk.ts";
import styles from "./bridge.module.css";

type Props = Readonly<{
  chain: BridgeChain;
  token: SourceToken;
  disabled: boolean;
  sdk: BridgeSdk;
  onChange: (token: SourceToken) => void;
}>;

export function SourceTokenPicker({ chain, token, disabled, sdk, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const catalog = useQuery({
    queryKey: ["bridge", "tokens", chain],
    queryFn: () => sdk.tokens(chain),
    enabled: open,
    staleTime: 30 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const term = search.trim();
  const folded = term.toLowerCase();
  const addressTerm = sourceAddressKey(chain, term);
  const loading = useDebouncedValue(catalog.isFetching, 300) && catalog.isFetching;
  const named = [...CHAINS[chain].tokens, ...(catalog.data ?? [])];
  const symbols = new Map<string, number>();
  for (const option of named) {
    const key = option.symbol.toLowerCase();
    symbols.set(key, (symbols.get(key) ?? 0) + 1);
  }
  const options = term
    ? named.filter((option) => {
      const address = sourceAddressKey(chain, option.mayan);
      return option.symbol.toLowerCase().includes(folded) || option.name?.toLowerCase().includes(folded)
        || (!option.native && address.includes(addressTerm));
    })
    : named;
  return (
    <>
      <DisclosureButton
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Coin to send: ${token.symbol}`}
        className={styles.sourcePick}
        disabled={disabled}
        onClick={(event) => {
          event.currentTarget.focus();
          setSearch("");
          setOpen(true);
        }}
        size="sm"
        variant="picker"
      >
        <TokenMark token={token} />
        <Ticker bare symbol={token.symbol} />
      </DisclosureButton>
      <Sheet
        className={styles.tokenSheet}
        initialFocus={() => window.matchMedia("(pointer: coarse)").matches ? null : input.current}
        labelledBy={titleId}
        onRequestClose={() => setOpen(false)}
        open={open}
      >
        <div className={styles.tokenHeading}>
          <SheetHeading id={titleId} title="Choose a token" />
          <IconButton aria-label="Close token picker" className={styles.tokenClose} onClick={() => setOpen(false)} size="touch"><CloseIcon /></IconButton>
        </div>
        <TextField aria-label="Search tokens" autoComplete="off" onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search name or address" ref={input} size="lg" type="search" value={search} />
        <div className={styles.tokenList}>
          {options.map((option) => {
            const selected = option.mayan === token.mayan;
            const duplicate = !option.native && (symbols.get(option.symbol.toLowerCase()) ?? 0) > 1;
            return (
              <div className={styles.tokenRow} key={option.mayan}>
                <Button
                  aria-pressed={selected}
                  className={styles.tokenOption}
                  onClick={() => { onChange(option); setOpen(false); }}
                  size="lg"
                  variant="ghost"
                >
                  <TokenMark token={option} />
                  <span className={styles.tokenText} data-ui-label="">
                    <b><Ticker bare symbol={option.symbol} /></b>
                    {option.name && option.name !== option.symbol ? <small>{option.name}</small> : null}
                  </span>
                  {selected ? <CheckIcon strong /> : null}
                </Button>
                {duplicate ? (
                  <div className={styles.tokenCopy}>
                    <CopyAddress copyLabel="Copy contract address" value={option.mayan} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {loading ? <SkeletonLine label="Loading tokens" /> : null}
        {catalog.isError && !catalog.isFetching ? (
          <EmptyState action={<Button onClick={() => { void catalog.refetch(); }} size="sm">Retry</Button>} compact role="alert" title={<DiagnosticText message={TOKENS_FAILED_TEXT} />} />
        ) : null}
        {catalog.isSuccess && !catalog.isFetching && options.length === 0 ? <EmptyState compact role="status" title="No tokens found" /> : null}
      </Sheet>
    </>
  );
}

function TokenMark({ token }: Readonly<{ token: SourceToken }>) {
  return <span aria-hidden="true" className={styles.tokenMark}>
    {token.logo ? (
      // eslint-disable-next-line @next/next/no-img-element -- Mayan's catalog supplies remote brand marks.
      <img alt="" height={20} loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} referrerPolicy="no-referrer" src={token.logo} width={20} />
    ) : null}
  </span>;
}
