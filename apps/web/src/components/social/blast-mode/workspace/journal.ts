import { decodeWorkspace, encodeWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { createWorkspaceStore } from "./model";
import { NETWORKS, emptyWorkspace, type Network } from "@blast/core/modules/social/blast-workspace/setup.ts";

export type JournalScope = Readonly<{
  actor:
    | Readonly<{ kind: "guest" }>
    | Readonly<{ kind: "account"; account_id: string }>;
  chain: "sui";
  network: Network;
}>;
export type JournalStorage = Pick<Storage, "getItem" | "setItem">;
export type JournalResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      original_bytes: string | null;
      error_name?: string;
    };
export type JournalRestore =
  | { status: "empty" }
  | { status: "restored"; migrated: boolean }
  | {
      status: "recovery_required";
      reason: string;
      original_bytes: string | null;
    };

export function workspaceJournalKey(scope: JournalScope): string {
  if (scope.chain !== "sui" || !NETWORKS.includes(scope.network))
    throw new Error("Invalid journal scope");
  const actor =
    scope.actor.kind === "guest"
      ? "guest"
      : `account:${encodeURIComponent(scope.actor.account_id)}`;
  if (
    scope.actor.kind !== "guest" &&
    (scope.actor.kind !== "account" || !scope.actor.account_id)
  )
    throw new Error("Invalid journal actor");
  return `blast.workspace:1:${scope.chain}:${scope.network}:${actor}`;
}

function readJournal(storage: JournalStorage, key: string) {
  let bytes: string | null;
  try {
    bytes = storage.getItem(key);
  } catch {
    return {
      workspace: emptyWorkspace(),
      bytes: null,
      restore: {
        status: "recovery_required",
        reason: "storage_read_failed",
        original_bytes: null,
      } as JournalRestore,
    };
  }
  if (bytes === null)
    return {
      workspace: emptyWorkspace(),
      bytes,
      restore: { status: "empty" } as JournalRestore,
    };
  const decoded = decodeWorkspace(bytes);
  if (!decoded.ok)
    return {
      workspace: emptyWorkspace(),
      bytes,
      restore: {
        status: "recovery_required",
        reason: decoded.reason,
        original_bytes: bytes,
      } as JournalRestore,
    };
  return {
    workspace: decoded.workspace,
    bytes,
    restore: {
      status: "restored",
      migrated: decoded.migrated,
    } as JournalRestore,
  };
}

/** Own one identity for this lifetime. Dispose and create another journal on account/network changes. */
export function createWorkspaceJournal({
  scope,
  storage,
}: Readonly<{ scope: JournalScope; storage: JournalStorage }>) {
  const key = workspaceJournalKey(scope);
  const loaded = readJournal(storage, key);
  const restore = Object.freeze(loaded.restore);
  const store = createWorkspaceStore(loaded.workspace);
  let savedBytes = loaded.bytes;
  let persistence: JournalResult =
    loaded.restore.status === "recovery_required"
      ? {
          ok: false,
          reason: loaded.restore.reason,
          original_bytes: loaded.bytes,
        }
      : { ok: true };
  let disposed = false;
  function flush(): JournalResult {
    if (disposed)
      return { ok: false, reason: "disposed", original_bytes: savedBytes };
    if (loaded.restore.status === "recovery_required") return persistence;
    const current = readJournal(storage, key);
    if (current.restore.status === "recovery_required")
      return (persistence = {
        ok: false,
        reason: current.restore.reason,
        original_bytes: current.bytes,
      });
    if (current.bytes !== savedBytes) return (persistence = {
      ok: false, reason: "workspace_changed_in_another_tab", original_bytes: current.bytes,
    });
    const encoded = encodeWorkspace(store.getSnapshot());
    if (!encoded.ok)
      return (persistence = {
        ok: false,
        reason: encoded.reason,
        original_bytes: savedBytes,
      });
    try {
      storage.setItem(key, encoded.bytes);
      savedBytes = encoded.bytes;
      return (persistence = { ok: true });
    } catch (error) {
      return (persistence = {
        ok: false,
        reason: "storage_write_failed",
        original_bytes: savedBytes,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  const unsubscribe = store.subscribe(flush);
  return {
    key,
    store,
    restore,
    getPersistence: () => Object.freeze({ ...persistence }),
    flush: () => Object.freeze({ ...flush() }),
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}

/** Call only on the client; obtaining localStorage may itself throw SecurityError. */
export function createBrowserWorkspaceJournal(
  scope: JournalScope,
  host: Pick<Window, "localStorage"> = window,
) {
  const storage: JournalStorage = {
    getItem: (key) => host.localStorage.getItem(key),
    setItem: (key, value) => host.localStorage.setItem(key, value),
  };
  return createWorkspaceJournal({ scope, storage });
}
