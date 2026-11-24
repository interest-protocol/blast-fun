"use client";

import { useEffect, useEffectEvent } from "react";
import type { PresaleMarketFrame } from "@blast/core/modules/live/presale-market-frames.ts";
import { tabMarketStream } from "#web/components/launchpad/market-stream-hub.ts";

export function usePresaleMarketStream(presale: string, receive: (frame: PresaleMarketFrame) => void, onReady?: (checkpoint: number | null) => void) {
  const accept = useEffectEvent((frame: PresaleMarketFrame) => {
    if (!document.hidden) receive(frame);
  });
  const ready = useEffectEvent((checkpoint: number | null) => onReady?.(checkpoint));

  useEffect(() => {
    const subscription = tabMarketStream()?.subscribe({
      pools: [],
      presale,
      expected: null,
      listener: { state: () => {}, presale: (frame) => accept(frame), presaleReady: (live) => ready(live) },
    });
    return () => subscription?.stop();
  }, [presale]);
}
