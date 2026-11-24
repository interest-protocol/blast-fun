"use client";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { SELL_PRESETS, type SellPreset } from "../trade/trade-ticket.ts";
import styles from "./coins.module.css";

export function AmountPresets({ selected = null, disabled, onPick }: Readonly<{
  selected?: SellPreset | null;
  disabled: boolean;
  onPick(preset: SellPreset): void;
}>) {
  return <div aria-label="Amount presets" className={styles.presets} role="group">
    {SELL_PRESETS.map(([value, label]) => <Button aria-pressed={selected === value} className={styles.preset} disabled={disabled} key={value} onClick={() => onPick(value)} size="sm" variant="ghost">{label}</Button>)}
  </div>;
}
