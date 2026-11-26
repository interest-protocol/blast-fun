"use client";

import { pollInterval } from "#web/lib/query/polling.ts";
import { readBrowserStorage, writeBrowserStorage } from "#web/lib/browser-storage.ts";
import { useContext, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { Button, IconButton } from "#web/components/blast-ui/Button.tsx";
import { Checkbox } from "#web/components/blast-ui/Checkbox.tsx";
import { PeopleIcon, GearIcon } from "#web/components/blast-ui/Icons.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { followingTapeQuery } from "../../coin-home/home-client";
import { tapeParts } from "../../coin-home/home-model";
import { presaleHref } from "../../feed-ui/shell-bridge-model";
import type {
  HomeActivityStreamEvent,
  HomeTapeEvent,
} from "@blast/core/web/contracts/home.ts";
import { bxAgo } from "@blast/core/web/format.ts";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { useWorkspace } from "./workspace-context";
import { WorkspaceToolbarTarget } from "./frame-targets";
import {
  useCurrentBlastAccount,
  useCurrentBlastActions,
} from "./BlastActionProvider";
import { ActorAvatar } from "./ActorCell";
import { actorIdentity } from "./actor-identity";
import { activityStreamQuery } from "./activity-stream-query";
import {
  discoveryPreferences,
  discoveryKindVisible,
  type DiscoveryPreferences,
} from "./discovery-preferences";
import styles from "./WorkspaceSignals.module.css";

const preferenceEvent = "blast:workspace-discovery";
function subscribePreferences(notify: () => void) {
  window.addEventListener("storage", notify);
  window.addEventListener(preferenceEvent, notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(preferenceEvent, notify);
  };
}
const emptySnapshot = () => "";

function useDiscoveryPreferences(owner: string) {
  const key = `blast.workspace.discovery:1:${owner}`;
  const [fallback, setFallback] = useState<{
    key: string;
    value: string;
  } | null>(null);
  const raw = useSyncExternalStore(
    subscribePreferences,
    () => {
      if (fallback?.key === key) return fallback.value;
      return readBrowserStorage("local", key) ?? "";
    },
    emptySnapshot,
  );
  const change = (next: DiscoveryPreferences) => {
    const value = JSON.stringify(next);
    try {
      if (!writeBrowserStorage("local", key, value)) {
        setFallback({ key, value });
        return;
      }
      window.dispatchEvent(new Event(preferenceEvent));
    } catch {
      setFallback({ key, value });
    }
  };
  return { preferences: discoveryPreferences(raw), change };
}

/** One bounded strip: private Following or the existing public activity stream. */
function useSignalRead() {
  const { presentation, entry_generation } = useWorkspace();
  const { accountState, getAccessToken } = useCurrentBlastAccount();
  const authority = useCurrentBlastActions();
  const account = authority.authenticated ? accountState?.account : null;
  const owner = account?.account_id ?? "guest";
  const { preferences, change } = useDiscoveryPreferences(owner);
  const source = account ? preferences.source : "recent";
  const active = presentation.mode_open && presentation.document_visible;
  const client = useAppQueryClient();
  const following = useQuery(
    {
      ...followingTapeQuery(
        getAccessToken,
        `${owner}:${accountState?.sessionIdentity ?? ""}:${entry_generation}`,
        "24h",
      ),
      enabled: active && !!account && source === "following",
      gcTime: 0,
      retry: false,
      refetchInterval: (query) => (active ? pollInterval(30_000, query) : false),
      refetchOnWindowFocus: false,
    },
    client,
  );
  const recent = useQuery(
    {
      ...activityStreamQuery("24h"),
      enabled: active && source === "recent",
      refetchInterval: (query) => (active ? pollInterval(30_000, query) : false),
      refetchOnWindowFocus: false,
    },
    client,
  );
  const read = source === "following" ? following : recent;
  return { read, preferences, source, change, signedIn: !!account };
}

export function WorkspaceSignals() {
  const { read, preferences, source, change, signedIn } = useSignalRead();
  const toolbarTarget = useContext(WorkspaceToolbarTarget);
  const data = read.data;
  const empty = !!data && !read.isError && data.events.length === 0;
  const controls = <div className={styles.toolbarControl}>
    <SignalPreferences
      preferences={preferences}
      source={source}
      signedIn={signedIn}
      onChange={change}
    />
  </div>;
  // Beside the header bar the strip keeps its row when there is no activity, so the board never moves up or down after it loads (owner, 2026-10-29).
  const shown = !!toolbarTarget || !empty;
  return <>
    {toolbarTarget && createPortal(controls, toolbarTarget)}
    {shown && (
      <header className={styles.strip} data-empty={(!toolbarTarget && empty) || undefined} data-workspace-strip="" aria-label="Discovery activity">
        {(toolbarTarget || !empty) && <>
          <span className={styles.source}>
            <PeopleIcon />
            {source === "following" ? "Following" : "Recent activity"}
          </span>
          <div className={styles.viewport}>
            <SignalResults
              data={data}
              error={read.isError}
              retry={() => void read.refetch()}
              preferences={preferences}
              following={source === "following"}
            />
          </div>
        </>}
        {!toolbarTarget && controls}
      </header>
    )}
  </>;
}

type SignalData = Readonly<{
  events: readonly (HomeTapeEvent | HomeActivityStreamEvent)[];
  clock_ms: number;
  as_of: { lag_ms: number };
}>;
function SignalResults({
  data,
  error,
  retry,
  preferences,
  following,
}: Readonly<{
  data: SignalData | undefined;
  error: boolean;
  retry: () => void;
  preferences: DiscoveryPreferences;
  following: boolean;
}>) {
  const events = (data?.events ?? []).filter((event) =>
    discoveryKindVisible(event.kind, preferences),
  );
  if (!data)
    return error ? (
      <span className={styles.status} role="alert">
        Activity unavailable.{" "}
        <Button size="sm" variant="ghost" onClick={retry}>
          Retry
        </Button>
      </span>
    ) : (
      <span role="status" aria-label="Loading discovery activity">
        <SkeletonText>People and recent activity</SkeletonText>
      </span>
    );
  const filtersEnabled =
    preferences.buy || preferences.sell || preferences.presale;
  // A phone shows the short line; the rest stays for assistive technology (audit inventory).
  const empty = following
    ? <span>No recent activity<span className={styles.statusMore}> from accounts you follow</span></span>
    : "No recent activity";
  return (
    <>
      {error && (
        <span role="alert" className={styles.status}>
          Couldn’t refresh.{" "}
          <Button size="sm" variant="ghost" onClick={retry}>
            Retry
          </Button>
        </span>
      )}
      {data.as_of.lag_ms > 60_000 && (
        <span className={styles.status}>Delayed</span>
      )}
      {events.length ? (
        <ul
          className={styles.events}
          aria-label={
            following
              ? "Recent activity from accounts you follow"
              : "Recent Blast activity"
          }
        >
          {events.map((event) => (
            <Signal key={event.activity_id} event={event} now={data.clock_ms} />
          ))}
        </ul>
      ) : (
        <span className={styles.status}>
          {filtersEnabled ? empty : "Choose an activity type to show."}
        </span>
      )}
    </>
  );
}

function Signal({
  event,
  now,
}: Readonly<{ event: HomeTapeEvent | HomeActivityStreamEvent; now: number }>) {
  const hidden = useShellPrefs().amountsHidden;
  const identity = actorIdentity(event.actor);
  const parts = tapeParts({
    kind: event.kind,
    quote: hidden ? null : event.quote,
  });
  const name = identity.kind === "account" ? identity.name : identity.short;
  const content = (
    <>
      <ActorAvatar identity={identity} size={22} />
      <strong>{name}</strong>
      <span data-side={event.kind}>{parts.before}</span>
      <b>{event.coin.symbol}</b>
      {parts.after && <span>{parts.after}</span>}
      <time dateTime={new Date(event.occurred_at_ms).toISOString()}>
        {bxAgo(event.occurred_at_ms, now)}
      </time>
    </>
  );
  return (
    <li>
      <IntentLink
        href={event.coin.presale_id === null ? coinPagePath(event.coin.coin_type) : presaleHref(event.coin.presale_id)}
        className={styles.event}
      >
        {content}
      </IntentLink>
    </li>
  );
}

function SignalPreferences({
  preferences,
  source,
  signedIn,
  onChange,
}: Readonly<{
  preferences: DiscoveryPreferences;
  source: DiscoveryPreferences["source"];
  signedIn: boolean;
  onChange: (value: DiscoveryPreferences) => void;
}>) {
  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <IconButton
            aria-label="Activity strip settings"
            size="chip"
            variant="secondary"
          />
        }
      >
        <GearIcon />
      </Popover.Trigger>
      <PopoverSurface
        positioner={{ side: "bottom", align: "end", sideOffset: 8, collisionPadding: 12, className: styles.layer }}
        popup={{ className: styles.popup }}
      >
            {/* Named by what it sets (audit 06): the activity strip's source and its kinds of activity. */}
            <Popover.Title>Activity strip</Popover.Title>
            <div
              className={styles.sources}
              role="group"
              aria-label="Activity source"
            >
              <Button
                size="sm"
                variant="segment"
                aria-pressed={source === "following"}
                disabled={!signedIn}
                onClick={() =>
                  onChange({ ...preferences, source: "following" })
                }
              >
                Following
              </Button>
              <Button
                size="sm"
                variant="segment"
                aria-pressed={source === "recent"}
                onClick={() => onChange({ ...preferences, source: "recent" })}
              >
                All activity
              </Button>
            </div>
            {!signedIn && <p>Sign in to see accounts you follow.</p>}
            <fieldset>
              <legend>Show</legend>
              {(
                [
                  ["buy", "Buys"],
                  ["sell", "Sells"],
                  ["presale", "Presale activity"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <Checkbox
                    checked={preferences[key]}
                    onChange={(event) =>
                      onChange({
                        ...preferences,
                        [key]: event.currentTarget.checked,
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <div className={styles.footer}>
              <Popover.Close render={<Button size="sm" variant="secondary" />}>
                Done
              </Popover.Close>
            </div>
          </PopoverSurface>
    </Popover.Root>
  );
}
