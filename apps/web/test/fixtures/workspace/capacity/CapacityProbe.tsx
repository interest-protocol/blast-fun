"use client";

import { useEffect } from "react";
import {
  createBrowserWorkspaceJournal,
  workspaceJournalKey,
} from "../../../../src/components/social/blast-mode/workspace/journal.ts";
import { createWorkspaceStore } from "../../../../src/components/social/blast-mode/workspace/model.ts";
import {
  encodeWorkspace,
  WORKSPACE_MAX_BYTES,
  type WorkspaceWriteEnvelope,
} from "@blast/core/modules/social/blast-workspace/codec.ts";
import {
  CAPACITY_COUNTS,
  CAPACITY_SAMPLES,
  canonical,
  capacityEnvelope,
  createCapacityWorkspace,
  exactEnvelope,
  utf8Bytes,
} from "./workload.ts";

const scope = {
  actor: { kind: "guest" },
  chain: "sui",
  network: "mainnet",
} as const;
const route = "/api/social/me/blast-workspace";
type Phase = "warmup" | "primary";

async function digest(value: unknown) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function requireFact(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Capacity evidence failed: ${label}`);
}

async function token(account: number): Promise<string> {
  const response = await fetch(`/api/fixture/sync?account=${account}`, {
    cache: "no-store",
  });
  requireFact(response.ok, "fixture issuer");
  return (await response.json()).token;
}

async function read(accessToken: string) {
  const response = await fetch(route, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  requireFact(response.ok, "private read");
  return response.json();
}

async function write(accessToken: string, envelope: WorkspaceWriteEnvelope) {
  const body = JSON.stringify(envelope);
  const started = performance.now();
  const response = await fetch(route, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body,
  });
  const reply = await response.json();
  const elapsed = performance.now() - started;
  return {
    status: response.status,
    api_write_ms: elapsed,
    envelope_bytes: utf8Bytes(body),
    response_bytes: utf8Bytes(JSON.stringify(reply)),
    revision: reply.revision ?? null,
    error: reply.error?.code ?? reply.error ?? null,
    cache_control: response.headers.get("cache-control"),
  };
}

async function guest(count: number, phase: Phase) {
  requireFact(
    CAPACITY_COUNTS.includes(count as 8 | 35 | 100),
    "bounded guest count",
  );
  const rows = [];
  const samples = phase === "warmup" ? 1 : CAPACITY_SAMPLES;
  for (let iteration = 0; iteration < samples; iteration++) {
    const workspace = createCapacityWorkspace(count);
    const store = createWorkspaceStore(workspace);
    const commitStarted = performance.now();
    store.setDataCollapsed(true);
    const modelCommitMs = performance.now() - commitStarted;
    const encodeStarted = performance.now();
    const encoded = encodeWorkspace(store.getSnapshot());
    const encodeMs = performance.now() - encodeStarted;
    requireFact(encoded.ok, "guest encode");
    // Untimed setup seed, followed by the actual browser journal restore and commit.
    localStorage.setItem(workspaceJournalKey(scope), JSON.stringify(workspace));
    let storageSetMs = 0;
    const host = {
      localStorage: {
        getItem: (key: string) => localStorage.getItem(key),
        setItem: (key: string, value: string) => {
          const started = performance.now();
          localStorage.setItem(key, value);
          storageSetMs += performance.now() - started;
        },
      } as Storage,
    };
    const restoreStarted = performance.now();
    const journal = createBrowserWorkspaceJournal(scope, host);
    const restoreMs = performance.now() - restoreStarted;
    requireFact(journal.restore.status === "restored", "guest restore");
    const journalStarted = performance.now();
    journal.store.setDataCollapsed(true);
    const journalCommitMs = performance.now() - journalStarted;
    requireFact(journal.getPersistence().ok, "guest persisted");
    const snapshot = journal.store.getSnapshot();
    journal.dispose();
    const readback = createBrowserWorkspaceJournal(scope);
    requireFact(
      canonical(readback.store.getSnapshot()) === canonical(snapshot),
      "guest readback",
    );
    readback.dispose();
    rows.push({
      phase,
      count,
      visible: snapshot.visible_order.length,
      retained: snapshot.retained_order.length,
      iteration,
      snapshot_bytes: utf8Bytes(encoded.bytes),
      envelope_bytes: utf8Bytes(
        JSON.stringify(capacityEnvelope(snapshot, 1, `t018-${count}`)),
      ),
      model_commit_ms: modelCommitMs,
      encode_ms: encodeMs,
      journal_commit_ms: journalCommitMs,
      local_storage_set_ms: storageSetMs,
      journal_restore_ms: restoreMs,
      readback_sha256: await digest(snapshot),
    });
  }
  return rows;
}

async function account(count: number, accountNumber: number, phase: Phase) {
  requireFact(
    CAPACITY_COUNTS.includes(count as 8 | 35 | 100) &&
      accountNumber >= 1 &&
      accountNumber <= 3,
    "bounded account workload",
  );
  const accessToken = await token(accountNumber);
  const before = await read(accessToken);
  const rows = [];
  const samples = phase === "warmup" ? 1 : CAPACITY_SAMPLES;
  for (let iteration = 0; iteration < samples; iteration++) {
    const store = createWorkspaceStore(createCapacityWorkspace(count));
    store.setDataCollapsed((Number(before.revision) + iteration) % 2 === 0);
    const snapshot = store.getSnapshot();
    const sequence = Number(before.revision) + iteration + 1;
    const result = await write(
      accessToken,
      capacityEnvelope(snapshot, sequence, `t018-${count}`),
    );
    requireFact(result.status === 200, `private write status ${result.status}`);
    const restored = await read(accessToken);
    requireFact(
      canonical(restored.workspace) === canonical(snapshot),
      "private readback",
    );
    rows.push({
      phase,
      count,
      visible: snapshot.visible_order.length,
      retained: snapshot.retained_order.length,
      iteration,
      sequence,
      snapshot_bytes: utf8Bytes(JSON.stringify(snapshot)),
      ...result,
      readback_sha256: await digest(restored.workspace),
    });
  }
  return { starting_revision: before.revision, samples: rows };
}

async function boundaryNear() {
  const accessToken = await token(4);
  const before = await read(accessToken);
  const nextRevision = Number(before.revision) + 1;
  const writerId = `t018-boundary-${String(nextRevision).padStart(8, "0")}`;
  const envelope = exactEnvelope(WORKSPACE_MAX_BYTES, writerId);
  const result = await write(accessToken, envelope);
  requireFact(result.status === 200, `near status ${result.status}`);
  requireFact(Number(result.revision) === nextRevision, "near fresh revision");
  const restored = await read(accessToken);
  requireFact(
    canonical(restored.workspace) === canonical(envelope.workspace),
    "near private readback",
  );
  return {
    starting_revision: before.revision,
    sequence: envelope.sequence,
    writer_id: writerId,
    ...result,
    visible: restored.workspace.visible_order.length,
    retained: restored.workspace.retained_order.length,
    snapshot_bytes: utf8Bytes(JSON.stringify(envelope.workspace)),
    readback_sha256: await digest(restored.workspace),
    response_sha256: await digest(restored),
  };
}

async function boundaryOver() {
  const accessToken = await token(4);
  const before = await read(accessToken);
  const writerId = `t018-boundary-${String(before.revision).padStart(8, "0")}`;
  const result = await write(accessToken, {
    ...exactEnvelope(WORKSPACE_MAX_BYTES + 1, writerId),
    sequence: 2,
  });
  const after = await read(accessToken);
  requireFact(result.status === 413, `over status ${result.status}`);
  requireFact(
    canonical(before) === canonical(after),
    "over preserved entire private response",
  );
  return {
    sequence: 2,
    writer_id: writerId,
    ...result,
    before_response_sha256: await digest(before),
    after_response_sha256: await digest(after),
    readback_sha256: await digest(after.workspace),
    revision_preserved: before.revision === after.revision,
    saved_at_preserved: before.saved_at_ms === after.saved_at_ms,
  };
}

function guestRestore() {
  const journal = createBrowserWorkspaceJournal(scope);
  const snapshot = journal.store.getSnapshot();
  const restore = journal.restore.status;
  journal.dispose();
  return digest(snapshot).then((sha256) => ({
    restore,
    visible: snapshot.visible_order.length,
    retained: snapshot.retained_order.length,
    sha256,
  }));
}

async function guestBoundary() {
  const base = createCapacityWorkspace(35);
  localStorage.setItem(workspaceJournalKey(scope), JSON.stringify(base));
  const journal = createBrowserWorkspaceJournal(scope);
  const overhead =
    utf8Bytes(JSON.stringify(exactEnvelope(WORKSPACE_MAX_BYTES))) -
    utf8Bytes(JSON.stringify(exactEnvelope(WORKSPACE_MAX_BYTES).workspace));
  const near = exactEnvelope(WORKSPACE_MAX_BYTES + overhead).workspace;
  const id = near.visible_order[0]!;
  journal.store.patchPanel(id, { coin: near.panels[id]!.coin });
  requireFact(journal.getPersistence().ok, "guest near persisted");
  const before = localStorage.getItem(journal.key)!;
  requireFact(
    utf8Bytes(before) === WORKSPACE_MAX_BYTES,
    "guest exact snapshot bytes",
  );
  const panel = journal.store.getSnapshot().panels[id]!;
  journal.store.patchPanel(id, {
    coin: {
      ...panel.coin,
      trade: {
        ...panel.coin.trade,
        buy: {
          ...panel.coin.trade.buy,
          typed: panel.coin.trade.buy.typed + "7",
        },
      },
    },
  });
  const persistence = journal.getPersistence();
  requireFact(!persistence.ok, "guest over visibly refused");
  const after = localStorage.getItem(journal.key)!;
  requireFact(before === after, "guest over preserved raw journal bytes");
  const inMemoryBytes = utf8Bytes(JSON.stringify(journal.store.getSnapshot()));
  journal.dispose();
  return {
    near_snapshot_bytes: utf8Bytes(before),
    over_snapshot_bytes: inMemoryBytes,
    reason: persistence.reason,
    before_sha256: await digest(JSON.parse(before)),
    after_sha256: await digest(JSON.parse(after)),
    byte_equal: before === after,
    restore: await guestRestore(),
  };
}

async function readiness() {
  const accessToken = await token(1);
  const me = await fetch("/api/social/me", {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const privateWorkspace = await read(accessToken);
  const anonymous = await fetch(route, { cache: "no-store" });
  requireFact(
    me.status === 200 && anonymous.status === 401,
    "private route readiness",
  );
  return {
    fixture_issuer: 200,
    me: me.status,
    private_workspace: 200,
    anonymous_workspace: anonymous.status,
    initial_revision: privateWorkspace.revision,
    workspace_absent: privateWorkspace.workspace === null,
    user_agent: navigator.userAgent,
    hardware_concurrency: navigator.hardwareConcurrency,
    time_origin_ms: performance.timeOrigin,
    pathname: location.pathname,
    error_overlay: Boolean(document.querySelector("[data-nextjs-dialog]")),
  };
}

const capacity = {
  readiness,
  guest,
  account,
  boundaryNear,
  boundaryOver,
  guestRestore,
  guestBoundary,
};
declare global {
  interface Window {
    t018Capacity?: typeof capacity;
  }
}

/** No UI or product instrumentation: this bridge exists only in the mounted test application. */
export function CapacityProbe() {
  useEffect(() => {
    window.t018Capacity = capacity;
    return () => {
      delete window.t018Capacity;
    };
  }, []);
  return null;
}
