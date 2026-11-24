import { Button } from "#web/components/blast-ui/Button.tsx";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import {
  fieldValue,
  type TradeFacts,
} from "./trade-model";
import styles from "./CoinTrade.module.css";
import { TradePresetEditor, TradeSlippageField } from "./TradePresetEditor";
import { useTradePresets } from "./use-trade-presets";
import { TRADE_PRESET_SLOTS, isTradePresetSelected, tradePresetDraft, tradePresetLabel } from "./trade-presets";
import { AMOUNT_STEPS, amountLength } from "./amount-length";
import { decimalText, dropDecimal, pasteDecimal } from "#web/lib/decimal-input.ts";

/** The ticket (BlastMode.dc.html): side and settings, the amount with its estimate, presets, payment coin, action, details. */
export function CoinTradeFields({
  trade,
  facts,
  busy,
  walletReady,
  authenticated,
  hidden,
  change,
  action,
  summary,
  balance,
  counterPicker,
  detailsSlot,
  feedbackId,
}: Readonly<{
  trade: PanelSetup["coin"]["trade"];
  facts: TradeFacts;
  busy: boolean;
  walletReady: boolean;
  authenticated: boolean;
  hidden: boolean;
  change: (trade: PanelSetup["coin"]["trade"]) => void;
  action?: ReactNode;
  summary?: ReactNode;
  balance?: ReactNode;
  counterPicker?: ReactNode;
  detailsSlot?: ReactNode;
  feedbackId?: string;
}>) {
  const presets = useTradePresets();
  const side = trade.side;
  const draft = { side, ...trade[side] };
  const tokenAmount = side === "sell" && draft.unit === "token";
  const presetDisabled = busy || !authenticated || !walletReady || (side === "sell" && (facts.held === null || facts.held <= 0));
  const value = draft.mode === "typed" ? draft.typed : fieldValue(draft, facts);
  const invalid = value.trim() !== "" && (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim().replaceAll(",", "")) || !/[1-9]/.test(value));
  const input = useRef<HTMLInputElement>(null);
  const setTyped = (typed: string) => change({ ...trade, [side]: { ...trade[side], typed, mode: "typed" } });
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    fitAmount(element);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitAmount(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, [value, side]);
  return (
    <>
      <div className={styles.tray}>
        <div className={styles.ticketHeader}>
        <div className={styles.side} role="group" aria-label="Buy or sell">
          {(["buy", "sell"] as const).map((each) => (
            <Button variant="segment" size="xs"
              className={styles.sideButton}
              key={each}
              type="button"
              disabled={busy}
              data-side={each}
              aria-keyshortcuts={each === "buy" ? "Q" : "E"}
              aria-pressed={side === each}
              onClick={() => change({ ...trade, side: each, ...(each === "sell" && trade.sell.typed === "" ? { sell: { ...trade.sell, unit: "token" } } : {}) })}
            >
              {each === "buy" ? "Buy" : "Sell"}
            </Button>
          ))}
        </div>
        <TradePresetEditor presets={presets} disabled={busy} settings={{ slippage_bps: trade.slippage_bps, onSave: slippage_bps => change({ ...trade, slippage_bps }) }} />
        </div>
        <div className={styles.entry}>
          <div className={styles.amountLabel}><span>{tokenAmount ? `Amount · ${facts.symbol}` : "Amount · USD"}</span>{balance}</div>
          <FieldGroup className={styles.amountField}>
            <span className={styles.amountLine}>
              <span className={styles.currency} data-token={tokenAmount} aria-hidden="true">$</span>
              <TextField size="sm"
                className="num"
                data-panel-amount=""
                placeholder="0.00"
                aria-label={tokenAmount ? `Amount of ${facts.symbol} to sell` : "Trade amount in USD"}
                inputMode="decimal"
                maxLength={AMOUNT_MAX_CHARS}
                aria-invalid={invalid}
                aria-describedby={feedbackId}
                autoComplete="off"
                type={hidden ? "password" : "text"}
                ref={input}
                value={value}
                disabled={busy}
                onInput={(event) => setTyped(decimalText(event))}
                onPaste={(event) => pasteDecimal(event, setTyped)}
                onDrop={(event) => dropDecimal(event, setTyped)}
              />
            </span>
            {summary}
          </FieldGroup>
          <TradePresets presets={presets} trade={trade} facts={facts} busy={busy} presetDisabled={presetDisabled} change={change} />
          {counterPicker}
        </div>
        {action}
        <div className={styles.meta}>{detailsSlot}</div>
      </div>
    </>
  );
}

export function CoinSlippage({
  trade,
  busy,
  change,
}: Readonly<{
  trade: PanelSetup["coin"]["trade"];
  busy: boolean;
  change: (trade: PanelSetup["coin"]["trade"]) => void;
}>) {
  return <TradeSlippageField value={trade.slippage_bps} disabled={busy} onChange={slippage_bps => change({ ...trade, slippage_bps })} />;
}

/**
 * Sets the amount's type step from its length, then steps further down while
 * the digits still overflow the field's width (a narrow card, Sell with both
 * chips). Past the smallest step, a mouse-driven field shrinks the digits to
 * fit; a touch field keeps the stylesheet's 16px focus size and scrolls with
 * its caret, so focusing it never zooms the page.
 * `--amount-chars` sizes the centred trade amount in `ch`, so its currency
 * sign stays beside the digits where `field-sizing` is unsupported.
 */
function fitAmount(element: HTMLInputElement) {
  element.style.setProperty("--amount-chars", String(Math.max(element.value.length || element.placeholder.length, 1)));
  element.style.removeProperty("font-size");
  let step = AMOUNT_STEPS.indexOf(amountLength(element.value));
  element.dataset.length = AMOUNT_STEPS[step];
  while (step < AMOUNT_STEPS.length - 1 && element.scrollWidth > element.clientWidth) {
    step += 1;
    element.dataset.length = AMOUNT_STEPS[step];
  }
  // Past the last step the digits shrink to fit the field exactly, never under the 12px floor (audit F15);
  // the input's length cap keeps a typed amount inside the field at that floor. An inline size would beat
  // the touch focus rule (16px, no zoom), so a coarse pointer keeps the stylesheet's size instead.
  if (element.scrollWidth <= element.clientWidth || element.clientWidth === 0) return;
  if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) return;
  let size = Number.parseFloat(getComputedStyle(element).fontSize);
  size = Math.max(AMOUNT_FLOOR_PX, Math.floor(size * (element.clientWidth / element.scrollWidth) * 2) / 2);
  element.style.fontSize = `${size}px`;
  // Glyph widths do not scale exactly with the size; half-pixel steps settle the last few pixels.
  while (size > AMOUNT_FLOOR_PX && element.scrollWidth > element.clientWidth) {
    size -= 0.5;
    element.style.fontSize = `${size}px`;
  }
}

/** The smallest the amount draws: the design system's 12px text floor. */
const AMOUNT_FLOOR_PX = 12;
/** The longest typed amount: a 15-digit whole part with grouping and nine decimals still fits the field at the floor. */
export const AMOUNT_MAX_CHARS = 30;

function TradePresets({ presets, trade, facts, busy, presetDisabled, change }: Readonly<{
  presets: ReturnType<typeof useTradePresets>;
  trade: PanelSetup["coin"]["trade"];
  facts: TradeFacts;
  busy: boolean;
  presetDisabled: boolean;
  change: (trade: PanelSetup["coin"]["trade"]) => void;
}>) {
  const side = trade.side;
  return <div className={styles.presetRow}>
    <div className={styles.presets} role="group" aria-label={side === "sell" ? "Share of available token balance" : "Buy amount presets"}>
      {TRADE_PRESET_SLOTS.map(slot => { const value = presets[side][slot - 1]!; return <Button variant="secondary" size="chip" className={styles.chip} type="button" key={slot}
        data-trade-preset={slot} aria-keyshortcuts={String(slot)}
        aria-pressed={isTradePresetSelected({ side, ...trade[side] }, value, facts)}
        title={`${tradePresetLabel(side, value)} · ${slot}`}
        disabled={busy || ((side === "sell" || value === "max") && presetDisabled)}
        onClick={() => {
          const next = tradePresetDraft(side, value, facts);
          if (!next) return;
          const { side: nextSide, ...amount } = next;
          change({ ...trade, [nextSide]: amount });
        }}>{tradePresetLabel(side, value)}</Button>; })}
    </div>
  </div>;
}
