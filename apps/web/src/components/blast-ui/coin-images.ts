import { useEffect, useSyncExternalStore } from "react";

// A URL has one failure state across tabs, headers and portfolio rows. Retrying
// after a short cooldown lets a transient image failure recover everywhere.
const failed = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; };
const snapshot = () => version;
const serverSnapshot = () => 0;
function notify() { version++; for (const listener of listeners) listener(); }
export function coinLogoUrl(src: string | null | undefined, canonical: string | undefined, failed: (url: string) => boolean) {
  return [src, canonical].find(value => value && /^(https:\/\/|data:image\/|\/(?!\/))/.test(value) && !failed(value));
}

export function useCoinImages() {
  const revision = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useEffect(() => {
    if (!failed.size) return;
    const timeout = setTimeout(() => {
      const now = Date.now();
      for (const [url, until] of failed) if (until <= now) failed.delete(url);
      notify();
    }, Math.max(0, Math.min(...failed.values()) - Date.now()));
    return () => clearTimeout(timeout);
  }, [revision]);
  return {
    failed: (url: string) => failed.has(url),
    fail: (url: string) => { if (!failed.has(url)) { failed.set(url, Date.now() + 30_000); notify(); } },
  };
}
