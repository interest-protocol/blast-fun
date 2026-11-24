import { IconButton, Button } from "#web/components/blast-ui/Button.tsx";
import { GearIcon } from "#web/components/blast-ui/Icons.tsx";
import { TextField } from "#web/components/blast-ui/TextField.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sheet, SheetClose, SheetCta, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { DEFAULT_TRADE_PRESETS, TRADE_PRESET_MAX_CHARS, TRADE_PRESET_SLOTS, tradePresetError, validateTradePresets, type TradePresets } from "./trade-presets";
import { saveTradePresets } from "./use-trade-presets";
import { WorkspaceUndo } from "../WorkspaceUndo";
import styles from "./TradePresetEditor.module.css";
import workspaceStyles from "../WorkspaceHost.module.css";

type Draft = Readonly<{ presets: TradePresets; slippage: number }>;
type Discarded = Draft & Readonly<{ host: Element }>;

export function TradePresetEditor({ presets, disabled, settings }: Readonly<{ presets: TradePresets; disabled: boolean; settings?: Readonly<{ slippage_bps: number; onSave: (bps: number) => void }> }>) {
  const [slippage, setSlippage] = useState(settings?.slippage_bps ?? 50);
  const [draft, setDraft] = useState<TradePresets>(presets);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  // Unsaved edits that Escape, the scrim or × closed on: Undo brings them back (audit F14).
  const [discarded, setDiscarded] = useState<Discarded | null>(null);
  // The presets Reset replaced, until the next edit: Reset's own Undo.
  const [beforeReset, setBeforeReset] = useState<TradePresets | null>(null);
  const heading = useId();
  const hint = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const valid = validateTradePresets(draft);
  // Restored edits show their problems at once; fresh ones wait for a blur.
  const edit = (next: Draft, restored = false) => {
    setDraft(next.presets); setSlippage(next.slippage); setError(""); setDiscarded(null); setBeforeReset(null); setOpen(true);
    setTouched(new Set(restored ? (["buy", "sell"] as const).flatMap(side => TRADE_PRESET_SLOTS.filter(slot => tradePresetError(side, next.presets[side][slot - 1]!)).map(slot => `${side}-${slot}`)) : []));
  };
  const dismiss = () => {
    const unsaved = JSON.stringify(draft) !== JSON.stringify(presets) || slippage !== (settings?.slippage_bps ?? 50);
    const host = trigger.current?.closest("[data-blast-ui]");
    setDiscarded(unsaved && host ? { presets: draft, slippage, host } : null);
    setOpen(false);
  };
  return <>
    <IconButton variant="ghost" size="sm" ref={trigger} className={styles.edit} type="button" disabled={disabled} aria-label={settings ? "Trade settings" : "Edit amount presets"} title={settings ? "Trade settings" : "Edit amount presets"} aria-haspopup="dialog" onClick={() => discarded ? edit(discarded, true) : edit({ presets, slippage: settings?.slippage_bps ?? 50 })}>
      {settings ? <GearIcon aria-hidden="true" /> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m14 5 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14v6Z" /></svg>}
    </IconButton>
    <Sheet className={`${workspaceStyles.tradeSheet} ${styles.editor}`} open={open} labelledBy={heading} onRequestClose={dismiss} onClosed={() => (undoButton.current ?? trigger.current)?.focus({ preventScroll: true })} hasCta>
      <SheetClose onClick={dismiss} />
      <SheetHeading id={heading} title={settings ? "Trade settings" : "Amount presets"} />
      <form onSubmit={event => { event.preventDefault(); if (!valid || disabled) return; if (saveTradePresets(draft)) { settings?.onSave(slippage); setDiscarded(null); setOpen(false); } else setError("Couldn’t save presets in this browser. Please try again."); }}>
        {settings && <TradeSlippageField value={slippage} disabled={disabled} onChange={setSlippage} />}
        <div className={styles.fields}>
          {(["buy", "sell"] as const).map(side => <fieldset key={side} className={styles.group}>
            <legend>{side === "buy" ? "Buy · USD" : "Sell · % of available tokens"}</legend>
            <div className={styles.row}>{TRADE_PRESET_SLOTS.map(slot => {
              const key = `${side}-${slot}`;
              const problem = touched.has(key) ? tradePresetError(side, draft[side][slot - 1]!) : null;
              return <label key={slot}>
                <span>Preset {slot}</span>
                <TextField size="sm" aria-label={`${side === "buy" ? "Buy" : "Sell"} preset ${slot}`} aria-describedby={`${hint}-${side}`} aria-invalid={problem ? true : undefined} aria-errormessage={problem ? `${hint}-${key}` : undefined} autoComplete="off" inputMode="text" maxLength={TRADE_PRESET_MAX_CHARS} value={draft[side][slot - 1]} onBlur={() => setTouched(new Set(touched).add(key))} onChange={event => {
                  const values = [...draft[side]]; values[slot - 1] = event.currentTarget.value.trim().toLowerCase();
                  setDraft({ ...draft, [side]: values }); setError(""); setBeforeReset(null);
                }} />
                {problem && <small className={styles.fieldError} id={`${hint}-${key}`}>{problem}</small>}
              </label>;
            })}</div>
            <p className={styles.groupHint} id={`${hint}-${side}`}>{side === "buy" ? "USD or max · Max 2 decimals" : "0.01–100% or max · Max 2 decimals"}</p>
          </fieldset>)}
        </div>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <SheetCta className={styles.actions}>
          {beforeReset
            ? <Button variant="ghost" size="sm" type="button" onClick={() => edit({ presets: beforeReset, slippage }, true)}>Undo reset</Button>
            : <Button variant="ghost" size="sm" type="button" onClick={() => { setBeforeReset(JSON.stringify(draft) === JSON.stringify(DEFAULT_TRADE_PRESETS) ? null : draft); setDraft(DEFAULT_TRADE_PRESETS); setTouched(new Set()); setError(""); }}>{settings ? "Reset presets" : "Reset defaults"}</Button>}
          <Button variant="primary" size="sm"  type="submit" disabled={!valid || disabled}>{settings ? "Save settings" : "Save presets"}</Button>
        </SheetCta>
      </form>
    </Sheet>
    {discarded && createPortal(<WorkspaceUndo className={styles.undo} label={settings ? "Settings not saved" : "Presets not saved"} undoRef={undoButton} undo={() => edit(discarded, true)} dismiss={() => setDiscarded(null)} onClose={() => trigger.current?.focus({ preventScroll: true })} />, discarded.host)}
  </>;
}

const SLIPPAGE_BPS = [10, 50, 100, 500] as const;

/** The design system's segmented control, not a native select: four common limits, plus a saved one outside them. */
export function TradeSlippageField({ value, disabled, onChange }: Readonly<{ value: number; disabled: boolean; onChange: (bps: number) => void }>) {
  const options = [...new Set([...SLIPPAGE_BPS, value])].sort((a, b) => a - b).map(bps => [bps, `${bps / 100}%`] as const);
  return <div className={styles.slippage}>
    <span aria-hidden="true">Slippage</span>
    <Segmented size="sm" label="Slippage" className={styles.slippageChoice} options={options} value={value} disabled={disabled} onChange={onChange} />
  </div>;
}
