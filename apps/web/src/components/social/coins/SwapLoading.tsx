import clsx from "clsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { SELL_PRESETS } from "../trade/trade-ticket.ts";
import styles from "./coins.module.css";

/** One amount box as the form draws it: the label and balance, the amount and its coin, the dollar value. */
function LoadingAmount({ label, out = false }: Readonly<{ label: string; out?: boolean }>) {
  return <div className={clsx(styles.amt, out && styles.amtOut)}>
    <div className={styles.amtTop}><span className={styles.lbl}>{label}</span><SkeletonText>Balance 0.00</SkeletonText></div>
    <div className={clsx(styles.amtRow, styles.loadingAmount)}><span className={styles.loadingValue}><SkeletonText>0.00</SkeletonText></span><span className={styles.loadingChip}><SkeletonText>COIN ▾</SkeletonText></span></div>
    <div className={styles.amtFoot}><SkeletonText>≈ $0.00</SkeletonText></div>
  </div>;
}

/**
 * The trading form before it loads (MA-8): the form's own boxes, slots and rows at their
 * final size, so nothing moves when it arrives, and the placeholders show only after
 * 300 ms. Assistive technology hears the operation's name; nothing reads it on screen.
 */
export function SwapLoading() {
  return <div aria-busy="true" aria-label="Loading trading form" className={clsx(styles.tradeBody, styles.swapLoading)} role="status">
    <div aria-hidden="true" className={styles.swapPair}>
      <LoadingAmount label="Pay" />
      <div className={styles.flipSlot}><span className={styles.swapFlip} /></div>
      <LoadingAmount label="Receive" out />
    </div>
    <div aria-hidden="true" className={styles.presets}>{SELL_PRESETS.map(([, label]) => <button className={styles.preset} disabled key={label} type="button">{label}</button>)}</div>
    <div aria-hidden="true" className={styles.validationSlot} />
    <div aria-hidden="true"><button className="btn btn-primary btn-lg btn-block" data-trade="" disabled type="button"><SkeletonText>Swap</SkeletonText></button></div>
  </div>;
}
