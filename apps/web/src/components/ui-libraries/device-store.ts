import { createStore } from "zustand/vanilla";

/** A per-device value kept in `localStorage` and held in a zustand store for the page's readers. */
export type DeviceStore<T> = Readonly<{
  /** The value; read from storage the first time it is asked for, telling no reader (none can have shown another yet). */
  get: () => T;
  /** Holds a new value and tells every reader (the caller has written storage first). */
  set: (value: T) => void;
  /** Holds a value read again from storage (another tab's write), telling no reader: the caller tells the one it serves. */
  hold: (value: T) => void;
  /** Forgets the value, so the next `get` reads storage again; `tell` says whether readers hear it now. */
  forget: (tell: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}>;

/**
 * OA-28 M6: the localStorage-backed preferences (`device-prefs`, `coin-pins`,
 * `feel-sound-pref`) hold their value in a zustand store. Each
 * keeps its own storage: the prototype's `blast.*` keys as plain JSON, written
 * before any reader hears the change, and read lazily on first use. zustand's
 * `persist` middleware would write a `{ state, version }` envelope under one
 * key (a device that used the prototype would lose its choice), after telling
 * the readers, and read at module load; so it is not used here. `undefined` is
 * "not read yet", so `T` never includes it.
 */
export function deviceStore<T>(read: () => T): DeviceStore<T> {
  const store = createStore<Readonly<{ value: T | undefined }>>()(() => ({ value: undefined }));
  let quiet = false;
  const silently = (value: T | undefined) => {
    quiet = true;
    try {
      store.setState({ value });
    } finally {
      quiet = false;
    }
  };
  return {
    get() {
      const held = store.getState().value;
      if (held !== undefined) return held;
      const value = read();
      silently(value);
      return value;
    },
    set(value) {
      store.setState({ value });
    },
    hold(value) {
      silently(value);
    },
    forget(tell) {
      if (tell) store.setState({ value: undefined });
      else silently(undefined);
    },
    subscribe(listener) {
      return store.subscribe(() => {
        if (!quiet) listener();
      });
    },
  };
}
