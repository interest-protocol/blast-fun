import { useEffect, useState } from "react";
import { exactAtoms, groupedExact } from "@blast/core/web/exact-amount.ts";
import type { SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";

type FundingCue = Readonly<{ kind: "raise" | "target"; text: string }>;
type FundingRead = Readonly<{ raised: bigint; target: bigint; live: boolean }>;
type FundingState = FundingRead & Readonly<{ celebrated: boolean; cue: FundingCue | null }>;

const CUE_MS = 4_000;

function nextFundingState(previous: FundingState, read: FundingRead, sale: SocialPresaleSummary): FundingState {
  const reached = read.target > 0n && read.raised >= read.target;
  const next = { ...read, celebrated: reached || previous.celebrated };
  const increase = read.raised - previous.raised;
  if (!read.live || !previous.live || read.target !== previous.target || increase <= 0n) {
    return { ...next, cue: null };
  }
  if (reached && !previous.celebrated) {
    return { ...next, cue: { kind: "target", text: "Target reached" } };
  }
  if (previous.cue?.kind === "target") {
    return { ...next, cue: previous.cue };
  }
  const amount = exactAtoms(increase, sale.quote_decimals);
  const text = amount && `+${groupedExact(amount, sale.quote_decimals)}\u00a0${sale.quote_symbol} raised`;
  return { ...next, cue: text ? { kind: "raise", text } : null };
}

/** Compare the totals already read by the catalog for this mounted sale. */
export function useFundingCue(sale: SocialPresaleSummary, live: boolean): FundingCue | null {
  const raised = BigInt(sale.raised_atoms);
  const target = BigInt(sale.target_atoms);
  const read = { raised, target, live };
  const [previous, setPrevious] = useState(() => nextFundingState({ ...read, celebrated: false, cue: null }, read, sale));

  if (raised !== previous.raised || target !== previous.target || live !== previous.live) {
    setPrevious(nextFundingState(previous, read, sale));
  }

  const { cue } = previous;
  useEffect(() => {
    if (!cue) return;
    const timer = window.setTimeout(() => {
      setPrevious((current) => current.cue === cue ? { ...current, cue: null } : current);
    }, CUE_MS);
    return () => window.clearTimeout(timer);
  }, [cue]);

  return cue;
}
