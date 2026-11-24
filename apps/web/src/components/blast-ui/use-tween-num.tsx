"use client";

import { coinCountText, type CoinCount } from "./tween-num";

/** What callers pass; figures no longer count (owner, 2026-10-28), so these change nothing. */
export type TweenNumOptions = Readonly<{
  duration?: number;
  hidden?: boolean;
  countUpOnReveal?: boolean;
}>;

/** A money figure or count, updated in place at once: its formatter's text for the read's value. */
export function TweenNum({ value, format }: Readonly<{ value: number; format: (value: number) => string } & TweenNumOptions>) {
  return <span>{format(value)}</span>;
}

/** A coin figure in the read's exact atoms. */
export function CoinTweenNum({ count, ...options }: Readonly<{ count: CoinCount } & TweenNumOptions>) {
  return <TweenNum format={(shown) => coinCountText(count, shown)} value={count.value} {...options} />;
}
