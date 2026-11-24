"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import type { SocialSettingsResponse } from "@blast/core/web/contracts/settings.ts";

import type { TokenSource } from "#web/components/social/social-api.ts";
import { saveSettings, saveFailureMessage } from "./settings-client";
import { applyPatch, isEmptyPatch, mergePatches, type SettingsPatch } from "./settings-model";

/**
 * The settings page's writes. A change shows at once; changes made while a
 * save is running wait and go together in the next one, so a run of toggles
 * is a few requests, not one each (the `social_account_update` bucket allows
 * 30 per 10 minutes). Each change may name a confirmation that runs once the
 * server stored it (the page's toasts). A refused or failed save puts back
 * what the server holds, reports why, and drops the confirmations of the
 * changes it carried.
 */
export type SettingsChange = Readonly<{ patch: SettingsPatch; onSaved?: (settings: SocialSettingsResponse) => void }>;

export function useSettingsSaver(
  input: Readonly<{
    accountId: string | null;
    stored: SocialSettingsResponse | null;
    getAccessToken: TokenSource | undefined;
    onStored(settings: SocialSettingsResponse): void;
    onFailed(message: string): void;
  }>,
): Readonly<{ shown: SocialSettingsResponse | null; change(change: SettingsChange): void; saving: boolean }> {
  const [pending, setPending] = useState<{ accountId: string | null; patch: SettingsPatch }>({ accountId: input.accountId, patch: {} });
  const [saving, setSaving] = useState(false);
  const queued = useRef<SettingsChange[]>([]);
  const running = useRef(false);
  const active = useRef(true);
  const request = useRef<{ controller: AbortController | null }>({ controller: null });
  const latest = useRef(input);
  useLayoutEffect(() => {
    active.current = true;
    const queue = queued.current;
    const currentRequest = request.current;
    return () => {
      active.current = false;
      queue.length = 0;
      currentRequest.controller?.abort();
    };
  }, []);
  useLayoutEffect(() => {
    if (latest.current.accountId !== input.accountId) {
      queued.current.length = 0;
      request.current.controller?.abort();
      setPending({ accountId: input.accountId, patch: {} });
    }
    latest.current = input;
  }, [input]);

  const flush = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setSaving(true);
    return await (async () => {
      while (queued.current.length > 0) {
        const batch = queued.current.splice(0);
        const patch = batch.reduce<SettingsPatch>((merged, item) => mergePatches(merged, item.patch), {});
        const { accountId, getAccessToken } = latest.current;
        if (isEmptyPatch(patch)) continue;
        const controller = new AbortController();
        request.current.controller = controller;
        const result = getAccessToken
          ? await saveSettings({ getAccessToken, signal: controller.signal }, patch)
          : { status: "refused", code: "unauthorized", retryAfterSeconds: null } as const;
        if (!active.current || controller.signal.aborted || accountId !== latest.current.accountId) continue;
        const rest = queued.current.reduce<SettingsPatch>((merged, item) => mergePatches(merged, item.patch), {});
        setPending({ accountId, patch: rest });
        if (result.status === "ok") {
          latest.current.onStored(result.body);
          for (const item of batch) item.onSaved?.(result.body);
        } else {
          latest.current.onFailed(saveFailureMessage(result));
        }
      }
    })().finally(() => {
      running.current = false;
      if (active.current) setSaving(false);
    });
  }, []);

  const change = useCallback(
    (next: SettingsChange) => {
      queued.current.push(next);
      const { accountId } = latest.current;
      setPending((current) => ({ accountId, patch: mergePatches(current.accountId === accountId ? current.patch : {}, next.patch) }));
      void flush();
    },
    [flush],
  );

  const shown = input.stored ? applyPatch(input.stored, pending.accountId === input.accountId ? pending.patch : {}) : null;
  return { shown, change, saving };
}
