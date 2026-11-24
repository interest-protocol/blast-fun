"use client";

import { useEffect, useRef } from "react";

import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";

import { happeningStore } from "../happening/happening-store";
import { useShellPortfolioContext } from "../shell-portfolio-context";
import { fundedSince, pageCelebrates, rememberCelebrated, presaleNotice } from "./celebration-model";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** One non-blocking notice for each live batch; later batches replace it instead of stacking. */
export function CelebrationHost() {
  const prefs = useDevicePrefs();
  const toast = useToast();
  const shell = useShellPortfolioContext();
  const seen = useRef(new Set<string>());
  const latest = useRef({ celebrate: prefs.celebrate, refresh: shell.refresh, toast });
  useEffect(() => {
    latest.current = { celebrate: prefs.celebrate, refresh: shell.refresh, toast };
  });

  useEffect(() => happeningStore().watchReads((previous, next) => {
    const completed = fundedSince(previous, next);
    if (completed.length === 0) return;
    latest.current.refresh();
    if (!latest.current.celebrate || !pageCelebrates()) return;
    const presales = completed.filter(({ presale }) => {
      const key = `${presale.presale_id}:${presale.lifecycle}`;
      if (seen.current.has(key)) return false;
      seen.current.add(key);
      return rememberCelebrated(storage(), key);
    }).map(({ presale }) => presale);
    const notice = presaleNotice(presales);
    if (notice) latest.current.toast(notice.title, { ...notice, id: "presale-lifecycle" });
  }), []);

  return null;
}
