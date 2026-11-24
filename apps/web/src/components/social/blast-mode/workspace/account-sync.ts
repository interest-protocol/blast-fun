import { createWorkspaceStore, type WorkspaceStore } from "./model";
import {
  emptyWorkspace,
  type Network,
  type WorkspaceV1,
} from "@blast/core/modules/social/blast-workspace/setup.ts";
import {
  encodeWorkspace,
  encodeWorkspaceWriteEnvelope,
  validateWorkspace,
  type WorkspaceWriteEnvelope,
} from "@blast/core/modules/social/blast-workspace/codec.ts";
import { workspaceJournalKey, type JournalStorage } from "./journal";
import type {
  BlastWorkspaceAcknowledgement,
  BlastWorkspaceResponse,
} from "@blast/core/web/contracts/blast-workspace.ts";

export class WorkspaceSyncError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number;
  constructor(code: string, retryable = false, retryAfterMs = 0) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}
export type WorkspaceApi = Readonly<{
  read: () => Promise<BlastWorkspaceResponse>;
  write: (
    write: WorkspaceWriteEnvelope,
  ) => Promise<BlastWorkspaceAcknowledgement>;
}>;
export type AccountWorkspaceState = Readonly<{
  phase: "loading" | "ready" | "error";
  sync: "local" | "saving" | "synced" | "error";
  store?: WorkspaceStore;
  /** Presentation-only recovery shell; no subscriptions or writes until remote hydration settles. */
  preview?: WorkspaceV1;
  reason?: string;
}>;
export function workspacePayloadRejected(reason?: string) {
  return [
    "body_too_large",
    "envelope_too_large",
    "workspace_too_large",
    "invalid_request",
    "workspace_schema_unsupported",
  ].includes(reason ?? "");
}
type Pending = { generation: number; workspace: WorkspaceV1 };
type Flight = Pending & { write: WorkspaceWriteEnvelope };
type Outbox = {
  version: 1;
  account_id: string;
  writer_id: string;
  sequence: number;
  generation: number;
  synced_generation: number;
  pending: Pending | null;
  flight: Flight | null;
  rejection?: string;
  dispatched_at_ms?: number;
  retry_not_before_ms?: number;
};

/** One immutable owner and writer for this lifetime. Remote snapshots install once per entry. */
export function createAccountWorkspace(
  input: Readonly<{
    accountId: string;
    writerId: string;
    storage: JournalStorage;
    api: WorkspaceApi;
    network?: Network;
    guest?: () => WorkspaceV1 | null;
  }>,
) {
  const journalKey = workspaceJournalKey({
    actor: { kind: "account", account_id: input.accountId },
    chain: "sui",
    network: input.network ?? "mainnet",
  });
  const outboxKey = `${journalKey}:outbox:${encodeURIComponent(input.writerId)}`;
  let outbox: Outbox = {
    version: 1,
    account_id: input.accountId,
    writer_id: input.writerId,
    sequence: 0,
    generation: 0,
    synced_generation: 0,
    pending: null,
    flight: null,
  };
  let state: AccountWorkspaceState = { phase: "loading", sync: "local" };
  const listeners = new Set<() => void>();
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: Promise<void> | undefined;
  let lastDispatch = -Infinity;
  let firstPending = 0;
  let lastEdit = 0;
  let attempts = 0;
  let blocked = false;
  let durable = true;
  let loaded = false;
  let starting: Promise<void> | undefined;
  function publish(patch: Partial<AccountWorkspaceState>) {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function persist() {
    if (!loaded) {
      publish({ sync: "error", reason: "journal_invalid" });
      return false;
    }
    try {
      input.storage.setItem(outboxKey, JSON.stringify(outbox));
      durable = true;
      return true;
    } catch {
      durable = false;
      publish({ sync: "error", reason: "storage_write_failed" });
      return false;
    }
  }
  function journal(workspace: WorkspaceV1) {
    const encoded = encodeWorkspace(workspace);
    if (!encoded.ok) {
      publish({ sync: "error", reason: encoded.reason });
      return false;
    }
    try {
      input.storage.setItem(journalKey, encoded.bytes);
      return true;
    } catch {
      publish({ sync: "error", reason: "storage_write_failed" });
      return false;
    }
  }
  function install(workspace: WorkspaceV1, synced: boolean) {
    if (disposed || state.store) return;
    const store = createWorkspaceStore(workspace);
    state = {
      phase: "ready",
      sync: synced ? "synced" : "error",
      store,
      ...(synced ? {} : { reason: state.reason ?? "load_failed" }),
    };
    if (synced && !journal(workspace))
      publish({ sync: "error", reason: "storage_write_failed" });
    unsubscribe = store.subscribe(() => {
      if (workspacePayloadRejected(outbox.rejection)) {
        outbox.flight = null;
        delete outbox.rejection;
        blocked = false;
        attempts = 0;
      }
      outbox.generation++;
      outbox.pending = {
        generation: outbox.generation,
        workspace: store.getSnapshot(),
      };
      if (!firstPending) firstPending = Date.now();
      lastEdit = Date.now();
      if (!blocked) publish({ sync: "local", reason: undefined });
      const journaled = journal(store.getSnapshot());
      const stored = persist();
      if (journaled && stored && !blocked) schedule();
    });
    publish({});
  }
  function schedule(delay?: number) {
    if (disposed || blocked || (!outbox.pending && !outbox.flight)) return;
    clearTimeout(timer);
    const editDue =
      delay === undefined
        ? Math.max(
            lastDispatch + 2000,
            Math.min(lastEdit + 500, firstPending + 5000),
          )
        : Math.max(lastDispatch + 2000, Date.now() + delay);
    timer = setTimeout(
      () => {
        void dispatch();
      },
      Math.max(
        0,
        Math.max(editDue, outbox.retry_not_before_ms ?? 0) - Date.now(),
      ),
    );
  }
  function failed(error: unknown) {
    const issue =
      error instanceof WorkspaceSyncError
        ? error
        : new WorkspaceSyncError("network_unavailable", true);
    publish({ sync: "error", reason: issue.code });
    if (issue.retryable) {
      const backoff =
        Math.min(30_000, 1000 * 2 ** attempts) * (0.75 + Math.random() * 0.5);
      outbox.retry_not_before_ms = Math.max(
        outbox.retry_not_before_ms ?? 0,
        Date.now() + Math.max(issue.retryAfterMs, backoff),
      );
      persist();
    }
    if (issue.retryable && attempts < 3) {
      attempts++;
      schedule(0);
    } else {
      blocked = true;
      if (!issue.retryable) {
        outbox.rejection = issue.code;
        persist();
      }
    }
    throw issue;
  }
  function prepareFlight() {
    if (outbox.flight || !outbox.pending) return;
    const next = outbox.pending;
    outbox.flight = {
      ...next,
      write: {
        initialize_if_absent: false,
        writer_id: input.writerId,
        sequence: ++outbox.sequence,
        workspace: next.workspace,
      },
    };
    outbox.pending = null;
  }
  function accepted(flight: Flight, ack: BlastWorkspaceAcknowledgement) {
    if (
      ack.account_id !== input.accountId ||
      ack.sequence !== flight.write.sequence
    )
      throw new WorkspaceSyncError("owner_or_ack_mismatch");
    outbox.synced_generation = flight.generation;
    outbox.flight = null;
    delete outbox.retry_not_before_ms;
    attempts = 0;
    firstPending = outbox.pending ? lastEdit : 0;
    if (persist())
      publish({ sync: outbox.pending ? "local" : "synced", reason: undefined });
    if (outbox.pending) schedule();
  }
  function existsConflict(error: unknown) {
    return (
      error instanceof WorkspaceSyncError && error.code === "workspace_exists"
    );
  }
  async function send() {
    if (disposed || blocked || !durable) return;
    if (
      Date.now() <
      Math.max(lastDispatch + 2000, outbox.retry_not_before_ms ?? 0)
    ) {
      schedule(0);
      return;
    }
    prepareFlight();
    const flight = outbox.flight;
    if (!flight) return;
    const encoded = encodeWorkspaceWriteEnvelope(flight.write);
    if (!encoded.ok) {
      blocked = true;
      outbox.rejection = encoded.reason;
      publish({ sync: "error", reason: encoded.reason });
      persist();
      return;
    }
    lastDispatch = Date.now();
    outbox.dispatched_at_ms = lastDispatch;
    if (!persist()) return;
    publish({ sync: "saving", reason: undefined });
    try {
      const ack = await input.api.write(flight.write);
      if (disposed) return;
      accepted(flight, ack);
    } catch (error) {
      if (disposed) return;
      if (flight.write.initialize_if_absent && existsConflict(error)) {
        outbox.flight = null;
        outbox.pending = null;
        persist();
        throw error;
      }
      failed(error);
    }
  }
  function dispatch(): Promise<void> {
    if (request) return request;
    request = send().finally(() => {
      request = undefined;
    });
    // Scheduled/background flush failures are represented in the external state.
    void request.catch(() => {});
    return request;
  }
  function validateOutbox(value: Outbox) {
    if (
      value.version !== 1 ||
      value.account_id !== input.accountId ||
      value.writer_id !== input.writerId ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 0 ||
      !Number.isSafeInteger(value.synced_generation) ||
      value.synced_generation < 0
    )
      throw new WorkspaceSyncError("journal_invalid");
    for (const item of [value.pending, value.flight])
      if (item) validateWorkspace(item.workspace);
    if (
      value.flight &&
      (!encodeWorkspaceWriteEnvelope(value.flight.write).ok ||
        value.flight.write.writer_id !== input.writerId ||
        value.flight.write.sequence !== value.sequence)
    )
      throw new WorkspaceSyncError("journal_invalid");
    if (
      value.dispatched_at_ms !== undefined &&
      !Number.isFinite(value.dispatched_at_ms)
    )
      throw new WorkspaceSyncError("journal_invalid");
    if (
      value.retry_not_before_ms !== undefined &&
      (!Number.isFinite(value.retry_not_before_ms) ||
        value.retry_not_before_ms < 0)
    )
      throw new WorkspaceSyncError("journal_invalid");
  }
  function load() {
    if (loaded) return;
    const bytes = input.storage.getItem(outboxKey);
    if (bytes !== null) {
      const value = JSON.parse(bytes) as Outbox;
      validateOutbox(value);
      // A fresh entry has resolved this same owner again; the API still checks
      // its captured authentication before any PUT. Never retarget an envelope.
      if (
        [
          "owner_changed",
          "unauthorized",
          "authentication_unavailable",
          "http_401",
          "session_expired",
        ].includes(value.rejection ?? "")
      )
        delete value.rejection;
      outbox = value;
      lastDispatch = Math.min(value.dispatched_at_ms ?? -Infinity, Date.now());
      blocked = Boolean(value.rejection);
    }
    loaded = true;
  }
  function cached() {
    if (outbox.pending) return outbox.pending.workspace;
    if (outbox.flight) return outbox.flight.workspace;
    const bytes = input.storage.getItem(journalKey);
    return bytes === null ? null : validateWorkspace(JSON.parse(bytes));
  }
  async function recoverPending() {
    if (!outbox.flight && !outbox.pending) return;
    try {
      await dispatch();
    } catch (error) {
      if (!existsConflict(error)) throw error;
    }
    if (outbox.flight || outbox.pending)
      throw new WorkspaceSyncError("pending_recovery");
  }
  async function initialize() {
    const workspace = input.guest?.() ?? emptyWorkspace();
    outbox.generation++;
    outbox.flight = {
      generation: outbox.generation,
      workspace,
      write: {
        initialize_if_absent: true,
        writer_id: input.writerId,
        sequence: ++outbox.sequence,
        workspace,
      },
    };
    if (!journal(workspace) || !persist())
      throw new WorkspaceSyncError("storage_write_failed");
    try {
      await dispatch();
      return workspace;
    } catch (error) {
      if (!existsConflict(error)) throw error;
      const winner = await input.api.read();
      if (winner.account_id !== input.accountId || !winner.workspace)
        throw new WorkspaceSyncError("invalid_initialization_winner");
      return winner.workspace;
    }
  }
  function previewCached() {
    try { const preview = cached(); if (preview) publish({ preview }); } catch { /* Keep unreadable bytes for recovery. */ }
  }
  async function enter() {
    try {
      load();
      previewCached();
      await recoverPending();
      const remote = await input.api.read();
      if (disposed) return;
      if (remote.account_id !== input.accountId)
        throw new WorkspaceSyncError("owner_changed");
      if (remote.workspace === null && remote.revision !== "0")
        throw new WorkspaceSyncError("invalid_response");
      const workspace = remote.workspace ?? (await initialize());
      install(workspace, true);
    } catch (error) {
      if (disposed) return;
      publish({
        phase: state.store ? "ready" : "error",
        sync: "error",
        reason: error instanceof Error ? error.message : "load_failed",
      });
      try {
        const fallback = cached();
        if (fallback) install(fallback, false);
      } catch {
        /* Preserve unreadable journal bytes for recovery. */
      }
    }
  }
  function retry() {
    if (!loaded) return start();
    if (
      outbox.rejection &&
      ![
        "unauthorized",
        "authentication_unavailable",
        "http_401",
        "session_expired",
      ].includes(outbox.rejection)
    )
      return Promise.resolve();
    delete outbox.rejection;
    blocked = false;
    attempts = 0;
    if (state.store && !journal(state.store.getSnapshot()))
      return Promise.resolve();
    if (!persist()) return Promise.resolve();
    // Once fallback is visible, recovery never replaces its active setup.
    if (state.store) {
      if (outbox.flight || outbox.pending) return dispatch().catch(() => {});
      return input.api
        .read()
        .then((remote) => {
          if (disposed) return;
          if (remote.account_id !== input.accountId)
            throw new WorkspaceSyncError("owner_changed");
          const same =
            remote.workspace &&
            JSON.stringify(remote.workspace) ===
              JSON.stringify(state.store!.getSnapshot());
          publish({
            sync: same ? "synced" : "local",
            reason: same ? undefined : "remote_available_on_reentry",
          });
        })
        .catch((error) =>
          publish({
            sync: "error",
            reason: error instanceof Error ? error.message : "load_failed",
          }),
        );
    }
    return start();
  }
  function start() {
    if (starting) return starting;
    starting = enter().finally(() => {
      starting = undefined;
    });
    return starting;
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    retry,
    flush() {
      clearTimeout(timer);
      return dispatch().catch(() => {});
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      unsubscribe?.();
      listeners.clear();
    },
  };
}
