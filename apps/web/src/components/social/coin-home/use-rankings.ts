"use client";

import { useState, useSyncExternalStore, type HTMLAttributes } from "react";

import type { HomeCoin } from "@blast/core/web/contracts/home.ts";

import { homeCoinKey } from "./home-model";
import { incomingCoinCount, useLiveCoins } from "./use-live-coins";

const PHONE_QUERY = "(max-width: 760px)";

function subscribeToPhone(onChange: () => void): () => void {
  const media = window.matchMedia?.(PHONE_QUERY);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

const onPhone = () => window.matchMedia?.(PHONE_QUERY).matches ?? false;
const desktopOnServer = () => false;

type ListInteraction = Readonly<{ pointer: boolean; focus: "keyboard" | "pointer" | null }>;
const noInteraction: ListInteraction = { pointer: false, focus: null };

/** Rankings stay live. Hold positions temporarily while a user is interacting with a row. */
export function useRankings(latest: readonly HomeCoin[] | undefined, key: string, { holdIncoming = false, checkpoint }: Readonly<{ holdIncoming?: boolean; checkpoint?: number }> = {}) {
  const phone = useSyncExternalStore(subscribeToPhone, onPhone, desktopOnServer);
  const [revision, setRevision] = useState(0);
  const [motionVersion, setMotionVersion] = useState(0);
  const [interaction, setInteraction] = useState({ key, ...noInteraction });
  const focused = interaction.focus === "keyboard" || (!phone && interaction.focus === "pointer");
  const interacting = interaction.key === key && (interaction.pointer || focused);
  const coins = useLiveCoins(latest, key, { paused: interacting, revision, holdIncoming, checkpoint });
  const incoming = holdIncoming && latest ? incomingCoinCount(coins, latest) : 0;
  const pending = latest !== undefined && (coins.length !== latest.length || coins.some((coin, index) => homeCoinKey(coin) !== homeCoinKey(latest[index]!)));
  const hold = (change: Partial<ListInteraction>) => setInteraction(previous => ({
    ...(previous.key === key ? previous : { key, ...noInteraction }), ...change,
  }));
  const interactionProps: HTMLAttributes<HTMLOListElement> = {
    onPointerEnter: event => { if (event.pointerType !== "touch") hold({ pointer: true }); },
    onPointerLeave: () => hold({ pointer: false }),
    onPointerDown: () => hold({ pointer: true }),
    onPointerUp: event => { if (event.pointerType === "touch") hold({ pointer: false }); },
    onPointerCancel: () => hold({ pointer: false }),
    onFocusCapture: event => hold({ focus: event.target.matches(":focus-visible") ? "keyboard" : "pointer" }),
    onBlurCapture: event => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        setMotionVersion(value => value + 1);
        hold({ focus: null });
      }
    },
  };
  const skipKeyboardMotion = (detail: number) => { if (detail === 0) setMotionVersion(value => value + 1); };
  return {
    coins, pending, incoming, motionVersion, interactionProps,
    update(detail: number) {
      skipKeyboardMotion(detail);
      setRevision(value => value + 1);
    },
  };
}

export type Rankings = ReturnType<typeof useRankings>;
