"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { soundChangeMark } from "#web/components/blast-feel/index.ts";
import { setDevicePref } from "#web/components/blast-ui/device-prefs.ts";
import type { TokenSource } from "#web/components/social/social-api.ts";
import { publicErrorMessage } from "#web/lib/errors.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import type { SocialSettingsResponse } from "@blast/core/web/contracts/settings.ts";
import { settingsQuery } from "../queries";
import { adoptAccountSettings } from "./use-account-settings-sync";

export type SettingsRecord =
  | Readonly<{ accountId: string; status: "ready"; settings: SocialSettingsResponse }>
  | Readonly<{ accountId: string; status: "error"; message?: string }>;

/** The account's settings, read on every visit through the shared cache (OA-38: the shell's one-time sync in flight is the same request); null on any failure. */
function freshSettings(client: QueryClient, getAccessToken: TokenSource, accountId: string): Promise<SocialSettingsResponse | null> {
  return client.fetchQuery({ ...settingsQuery(getAccessToken, accountId), staleTime: 0 }).catch(() => null);
}

export function useSettingsRecord(client: QueryClient, accountId: string | null, getAccessToken: TokenSource | undefined) {
  const [loaded, setLoaded] = useState<SettingsRecord | null>(null);
  const [generation, setGeneration] = useState(0);
  const tokens = useRef(getAccessToken);
  useEffect(() => {
    tokens.current = getAccessToken;
  }, [getAccessToken]);

  useEffect(() => {
    const source = tokens.current;
    if (!accountId || !source) return;
    const controller = new AbortController();
    const mark = soundChangeMark();
    void freshSettings(client, source, accountId).then((settings) => {
      if (controller.signal.aborted) return;
      if (settings) {
        setLoaded({ accountId, status: "ready", settings });
        // The account's explorer and sound choice, onto this device (its sound only if it has one and it
        // was not changed here since; an account with none is handed this device's own choice).
        adoptAccountSettings(settings, mark, source);
      } else setLoaded({ accountId, status: "error", message: publicErrorMessage(client.getQueryState(queryKeys.me.settings(accountId))?.error, "Your settings could not load. Try again.") });
    });
    return () => controller.abort();
  }, [accountId, client, generation]);

  const current = loaded?.accountId === accountId ? loaded : null;
  const setStored = useCallback(
    (settings: SocialSettingsResponse) => {
      if (accountId) setLoaded({ accountId, status: "ready", settings });
      // The save's answer is the account's settings now: the shared read takes it as is.
      client.setQueriesData({ queryKey: queryKeys.me.settings(accountId ?? undefined) }, settings);
      setDevicePref("explorer", settings.explorer);
    },
    [accountId, client],
  );
  const retry = () => setGeneration((value) => value + 1);
  return { current, setStored, retry, tokens };
}
