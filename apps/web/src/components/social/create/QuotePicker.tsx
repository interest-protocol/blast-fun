"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { prefersReducedMotion } from "#web/components/blast-ui/use-shell-prefs.ts";
import { CREATE_QUOTES } from "@blast/core/web/contracts/create.ts";
import { CoinArtwork } from "#web/components/blast-ui/CoinArtwork.tsx";
import type { CreateQuote } from "@blast/core/web/contracts/create.ts";
import { draftQuote, switchDraftQuote } from "@blast/core/modules/social/create/model.ts";

import { CheckIcon } from "./create-icons";
import { createStore, type CreateState } from "./create-store";
import { cx } from "./cx";
import { quoteDisplaySymbol, availablePickerQuotes, QUOTE_PICKER_COPY, quotePickCloseMs, quoteRowStep, quoteSwitchMessage, quoteUnavailableReason } from "./quote-coins";

/**
 * R3-42 / R3-86: Create's "Raise in" picker, oa41's `openQuotePicker`: a
 * sheet with the coins a sale can collect as one inset grouped list (each
 * row the coin and what its target and prices read in), the chosen one marked
 * by a pink check and nothing else, and the footer "Buyers can pay with either
 * coin. …". The coins are the server's answer (`CreateDraftResponse.quotes`:
 * admitted by the deployed policy and price/test gates), plus the draft's
 * own coin when available. Coins supported by either DEX are offered,
 * and each new coin defaults to Cetus when supported, otherwise Bluefin.
 *
 * Picking the other coin moves the check at once; a beat later (240 ms, none
 * under reduced motion) the sheet closes and the target, the limits and the
 * minimums are converted for SUI/USDC or kept unchanged for other coins (`switchDraftQuote`,
 * the gate's `niceRound`), then it says so: "Raising in SUI" / "Amounts
 * converted at today’s SUI price". Only this explicit pick converts; a
 * reload, a save or a publish never does. Without a price nothing is
 * converted at a guessed rate: SUI is not offered, and a pick it cannot
 * convert changes nothing. The current row takes focus on open, and
 * ↑ / ↓ move between the rows.
 */

/**
 * A quote coin's round mark, 24 or 34 px (the gate's `mark(k, …, { round:
 * true })`): SUI's drop on white with the gate's hairline ring
 * (`.mk-sui.round::after`), USDC's own disc.
 */
export function QuoteMark({ symbol, size = 24 }: Readonly<{ symbol: string; size?: 18 | 20 | 24 | 28 | 34 }>) {
  const coin = CREATE_QUOTES.find(quote => quote.symbol === symbol || quoteDisplaySymbol(quote.symbol) === symbol);
  return <span aria-hidden="true" className={cx("cr-qmark", size === 34 && "s34")} style={{ "--qmark": `${size / 16}rem` } as CSSProperties}><CoinArtwork coinType={coin?.quote_type} fallbackId="unknown-quote" src={null} size={size} /></span>;
}

export function QuotePicker({ state }: Readonly<{ state: CreateState }>) {
  const toast = useToast();
  const titleId = "cr-quote-title";
  const close = () => createStore.set({ quoteOpen: false });
  const current = draftQuote(state.draft);
  // The coin a pick has just checked, until the sheet closes a beat later.
  const [landing, setLanding] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const checked = landing ?? current.quote_type;
  const pick = (quote: CreateQuote) => {
    if (landing !== null || quoteUnavailableReason(state, quote.quote_type)) return;
    if (quote.quote_type === current.quote_type) {
      close();
      return;
    }
    const next = switchDraftQuote(state.draft, quote.quote_type, state.suiPrice);
    if (next === null) {
      // No price to convert at: nothing changes, and nothing is guessed.
      close();
      toast(`Raising in ${quoteDisplaySymbol(current.symbol)}`, { sub: "Blast can’t convert the amounts without today’s SUI price." });
      return;
    }
    setLanding(quote.quote_type);
    timer.current = setTimeout(() => {
      timer.current = null;
      setLanding(null);
      const latest = createStore.get();
      if (quoteUnavailableReason(latest, quote.quote_type)) return;
      const updated = switchDraftQuote(latest.draft, quote.quote_type, latest.suiPrice);
      if (updated === null) return;
      createStore.edit(() => updated);
      close();
      toast(`Raising in ${quoteDisplaySymbol(quote.symbol)}`, { sub: quoteSwitchMessage(current, quote) });
    }, quotePickCloseMs(prefersReducedMotion()));
  };
  const quotes = availablePickerQuotes(state);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = quoteRowStep(event.key, rows.current.indexOf(document.activeElement as HTMLButtonElement | null), quotes.length);
    if (step === null) return;
    event.preventDefault();
    rows.current[step]?.focus();
  };
  if (quotes.length === 0 || quotes.length === 1 && quotes[0]?.quote_type === current.quote_type) return null;
  return (
    <Sheet
      className={cx("cr-qsheet")}
      initialFocus={() => rows.current[Math.max(0, quotes.findIndex((quote) => quote.quote_type === checked))] ?? null}
      labelledBy={titleId}
      onRequestClose={close}
      open={state.quoteOpen}
    >
      <SheetClose onClick={close} />
      <SheetHeading id={titleId} title={QUOTE_PICKER_COPY.title} />
      <div aria-label="Raise in" className={cx("qp-group")} onKeyDown={onKeyDown} role="radiogroup">
        {quotes.map((quote, index) => {
          const unavailable = quoteUnavailableReason(state, quote.quote_type);
          return (
            <button
              aria-checked={quote.quote_type === checked}
              aria-disabled={unavailable !== null}
              className={cx("qp-row")}
              data-q={quote.symbol}
              key={quote.quote_type}
              onClick={() => pick(quote)}
              ref={(row) => {
                rows.current[index] = row;
              }}
              role="radio"
              type="button"
            >
              <QuoteMark size={34} symbol={quote.symbol} />
              <span className={cx("t")}>
                <b>{quoteDisplaySymbol(quote.symbol)}</b>
                <span>{unavailable ?? quote.note}</span>
              </span>
              <span aria-hidden="true" className={cx("qp-check")}>
                <CheckIcon />
              </span>
            </button>
          );
        })}
      </div>
      {quotes.some((quote) => quote.symbol === "TEST_SUI") ? <p className={cx("qp-foot")}>TSUI is a test coin on Bluefin. Buyers need TSUI; it has no real value.</p> : null}
    </Sheet>
  );
}
