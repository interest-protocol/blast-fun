"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { shortAddress } from "@blast/core/web/format.ts";

import { Button, DisclosureButton, IconButton } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { CheckIcon, CloseIcon } from "#web/components/blast-ui/Icons.tsx";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { SkeletonLine } from "#web/components/blast-ui/Skeleton.tsx";
import { TextField } from "#web/components/blast-ui/TextField.tsx";
import { Ticker } from "#web/components/blast-ui/Ticker.tsx";
import { useDebouncedValue } from "#web/lib/use-debounced-value.ts";

import type { BridgeChain } from "./bridge-config.ts";
import { CHAINS, sourceAddressKey, type SourceToken } from "./bridge-model.ts";
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
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
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
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };

  return (
    <Popover.Root modal="trap-focus" onOpenChange={changeOpen} open={open}>
      <Popover.Trigger
        aria-label={`Coin to send: ${token.symbol}`}
        disabled={disabled}
        ref={trigger}
        render={<DisclosureButton className={styles.sourcePick} size="sm" variant="picker"><TokenMark token={token} /><Ticker bare symbol={token.symbol} /></DisclosureButton>}
      />
      <PopoverSurface
        positioner={{ align: "end", className: styles.tokenLayer, collisionPadding: 12, sideOffset: 6 }}
        popup={{
          className: styles.tokenPopup,
          finalFocus: trigger,
          initialFocus: input,
          onKeyDown: (event) => {
            // The enclosing sheet traps Tab at document level. This portal owns focus while open.
            if (event.key === "Tab") event.stopPropagation();
          },
        }}
      >
        <div className={styles.tokenHeading}>
          <Popover.Title className={styles.tokenTitle}>Choose a token</Popover.Title>
          <Popover.Close render={<IconButton aria-label="Close token picker" size="touch"><CloseIcon /></IconButton>} />
        </div>
        <TextField aria-label="Search tokens" autoComplete="off" onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search name or address" ref={input} type="search" value={search} />
        <div className={styles.tokenList}>
          {options.map((option) => (
            <Button
              aria-pressed={option.mayan === token.mayan}
              className={styles.tokenOption}
              key={option.mayan}
              onClick={() => { onChange(option); changeOpen(false); }}
              size="lg"
              variant="ghost"
            >
              <TokenMark token={option} />
              <span className={styles.tokenText} data-ui-label="">
                <b><Ticker bare symbol={option.symbol} /></b>
                {option.name && option.name !== option.symbol ? <small>{option.name}</small> : null}
                {!option.native && (symbols.get(option.symbol.toLowerCase()) ?? 0) > 1 ? <small title={option.mayan}>{shortAddress(option.mayan)}</small> : null}
              </span>
              {option.mayan === token.mayan ? <CheckIcon strong /> : null}
            </Button>
          ))}
        </div>
        {loading ? <SkeletonLine label="Loading tokens" /> : null}
        {catalog.isError && !catalog.isFetching ? (
          <EmptyState action={<Button onClick={() => { void catalog.refetch(); }} size="sm">Retry</Button>} compact role="alert" title="Couldn’t load tokens" />
        ) : null}
        {catalog.isSuccess && !catalog.isFetching && options.length === 0 ? <EmptyState compact role="status" title="No tokens found" /> : null}
      </PopoverSurface>
    </Popover.Root>
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
