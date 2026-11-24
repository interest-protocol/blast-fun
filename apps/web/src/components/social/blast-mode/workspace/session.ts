import { SHELL_PHONE_QUERY } from "#web/components/blast-ui/nav.ts";

export type WorkspaceOrigin = Readonly<{
  path: string;
  scroll_x: number;
  scroll_y: number;
  main_scroll_top: number;
}>;
export type WorkspaceSessionState = Readonly<{
  open: boolean;
  generation: number;
  origin: WorkspaceOrigin | null;
  durable: boolean;
}>;

type SessionStorage = Pick<Storage, "getItem" | "setItem">;

/** The parser-time cover also uses this codec before any application modules have loaded. */
export function workspaceSessionCodec() {
  function localOrigin(value: unknown, site: string): WorkspaceOrigin | null {
    if (!value || typeof value !== "object") return null;
    const origin = value as Record<string, unknown>;
    if (
      typeof origin.path !== "string" ||
      !origin.path.startsWith("/") ||
      /[\\\u0000-\u0020]/.test(origin.path)
    )
      return null;
    const url = new URL(origin.path, site);
    if (url.origin !== site || url.username || url.password) return null;
    const positions = [origin.scroll_x, origin.scroll_y, origin.main_scroll_top];
    if (
      !positions.every(
        (value) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0,
      )
    )
      return null;
    return {
      path: url.pathname + url.search + url.hash,
      scroll_x: origin.scroll_x as number,
      scroll_y: origin.scroll_y as number,
      main_scroll_top: origin.main_scroll_top as number,
    };
  }

  return {
    key: "blast.workspace:session:1",
    closeEvent: "blast:workspace-boot-close",
    localOrigin,
    readOpenOrigin(bytes: string | null, site: string) {
      const saved: unknown = bytes === null ? null : JSON.parse(bytes);
      if (!saved || typeof saved !== "object" || !("open" in saved) || saved.open !== true || !("origin" in saved))
        return null;
      return localOrigin(saved.origin, site);
    },
    encode(open: boolean, origin: WorkspaceOrigin | null) {
      return JSON.stringify({ open, origin });
    },
  };
}

const persistedSession = workspaceSessionCodec();
export const WORKSPACE_SESSION_KEY = persistedSession.key;

/** Session navigation is browser-local and never part of a saved account setup. */
export function createWorkspaceSession(storage: SessionStorage, site: string, canOpen = () => true) {
  let state: WorkspaceSessionState = {
    open: false,
    generation: 0,
    origin: null,
    durable: true,
  };
  const listeners = new Set<() => void>();
  try {
    if (canOpen()) {
      const origin = persistedSession.readOpenOrigin(storage.getItem(WORKSPACE_SESSION_KEY), site);
      if (origin) state = { ...state, open: true, generation: 1, origin };
    }
  } catch {
    state = { ...state, durable: false };
  }
  function commit(next: WorkspaceSessionState) {
    state = next;
    try {
      storage.setItem(
        WORKSPACE_SESSION_KEY,
        persistedSession.encode(state.open, state.origin),
      );
      state = { ...state, durable: true };
    } catch {
      state = { ...state, durable: false };
    }
    for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(origin: WorkspaceOrigin) {
      if (!canOpen()) return;
      const validated = persistedSession.localOrigin(origin, site);
      if (!validated) throw new Error("Invalid workspace origin");
      if (!state.open)
        commit({
          ...state,
          open: true,
          origin: validated,
          generation: state.generation + 1,
        });
    },
    close() {
      if (state.open) commit({ ...state, open: false });
    },
  };
}

export type WorkspaceSession = ReturnType<typeof createWorkspaceSession>;

let session: WorkspaceSession | null = null;

export function workspaceSession(): WorkspaceSession {
  if (session) return session;
  const phone = window.matchMedia?.(SHELL_PHONE_QUERY);
  session = createWorkspaceSession(
    {
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
    },
    window.location.origin,
    () => !phone?.matches,
  );
  phone?.addEventListener("change", ({ matches }) => {
    if (matches) session?.close();
  });
  // A parser-time cover can be dismissed while the live host's chunk is still loading.
  window.addEventListener(persistedSession.closeEvent, () => session?.close());
  return session;
}
