type StorageScope = "local" | "session";

export function browserStorage(scope: StorageScope): Storage | null {
  try {
    return scope === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Optional device preferences can fall back when the browser denies storage. */
export function readBrowserStorage(scope: StorageScope, key: string): string | null {
  try {
    return browserStorage(scope)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeBrowserStorage(scope: StorageScope, key: string, value: string): boolean {
  try {
    const storage = browserStorage(scope);
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
