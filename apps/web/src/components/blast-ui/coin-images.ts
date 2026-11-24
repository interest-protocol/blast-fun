import { useEffect, useSyncExternalStore } from "react";

// A URL has one failure state across tabs, headers and portfolio rows. Retrying
// after a short cooldown lets a transient image failure recover everywhere.
const noFailures = new Map<string, number>();
let failures = noFailures;
const listeners = new Set<() => void>();
const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; };
const snapshot = () => failures;
const serverSnapshot = () => noFailures;
function publish(next: Map<string, number>) {
  failures = next;
  for (const listener of listeners) listener();
}
export function coinLogoUrl(src: string | null | undefined, canonical: string | undefined, failed: (url: string) => boolean) {
  return [src, canonical].find(value => value && /^(https:\/\/|data:image\/|\/(?!\/))/.test(value) && !failed(value));
}

export function useCoinImages() {
  const failed = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useEffect(() => {
    if (!failed.size) return;
    const timeout = setTimeout(() => {
      const now = Date.now();
      publish(new Map([...failures].filter(([, until]) => until > now)));
    }, Math.max(0, Math.min(...failed.values()) - Date.now()));
    return () => clearTimeout(timeout);
  }, [failed]);
  return {
    failed: (url: string) => failed.has(url),
    fail: (url: string) => {
      if (!failures.has(url)) publish(new Map(failures).set(url, Date.now() + 30_000));
    },
  };
}
