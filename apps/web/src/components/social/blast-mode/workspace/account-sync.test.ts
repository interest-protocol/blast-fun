import assert from "node:assert/strict";
import test from "node:test";
import { createAccountWorkspace } from "./account-sync";
import { emptyWorkspace } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { encodeWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { workspaceJournalKey } from "./journal";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}
const saved = (workspace = emptyWorkspace()) => ({
  account_id: "A",
  revision: "7",
  saved_at_ms: 10,
  workspace,
});

test("saved empty account wins over guest setup without a write", async () => {
  const local = storage();
  let writes = 0;
  const account = createAccountWorkspace({
    accountId: "A",
    writerId: "tab-a",
    storage: local,
    api: {
      read: async () => saved(),
      write: async () => {
        writes++;
        throw new Error("unexpected write");
      },
    },
    guest: () => ({
      ...emptyWorkspace(),
      data: { ...emptyWorkspace().data, collapsed: true },
    }),
  });
  await account.start();
  assert.equal(account.getSnapshot().phase, "ready");
  assert.deepEqual(
    account.getSnapshot().store!.getSnapshot(),
    emptyWorkspace(),
  );
  assert.equal(account.getSnapshot().sync, "synced");
  assert.equal(writes, 0);
  account.dispose();
});

test("confirmed absence imports guest once, while failed reads never initialize", async () => {
  const guest = {
    ...emptyWorkspace(),
    data: { ...emptyWorkspace().data, collapsed: true },
  };
  const writes: unknown[] = [];
  const account = createAccountWorkspace({
    accountId: "A",
    writerId: "tab-a",
    storage: storage(),
    guest: () => guest,
    api: {
      read: async () => ({
        ...saved(),
        revision: "0",
        workspace: null,
        saved_at_ms: null,
      }),
      write: async (write) => {
        writes.push(write);
        return {
          account_id: "A",
          sequence: write.sequence,
          revision: "1",
          saved_at_ms: 12,
        };
      },
    },
  });
  await account.start();
  assert.deepEqual(writes, [
    {
      initialize_if_absent: true,
      writer_id: "tab-a",
      sequence: 1,
      workspace: guest,
    },
  ]);
  assert.deepEqual(account.getSnapshot().store!.getSnapshot(), guest);
  account.dispose();
  const failed = createAccountWorkspace({
    accountId: "A",
    writerId: "tab-a",
    storage: storage(),
    guest: () => guest,
    api: {
      read: async () => {
        throw new Error("offline");
      },
      write: async () => {
        throw new Error("must not initialize");
      },
    },
  });
  await failed.start();
  assert.equal(failed.getSnapshot().phase, "error");
  failed.dispose();
});

async function settled() {
  for (let n = 0; n < 15; n++) await Promise.resolve();
}
const ack = (sequence: number, revision = "8") => ({
  account_id: "A",
  sequence,
  revision,
  saved_at_ms: 20,
});
test("Retry-After survives edits, flush, reconnect and reload before the uncertain write resolves", async (t) => {
  const { WorkspaceSyncError } = await import("./account-sync");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const local = storage();
  const writes: import("@blast/core/modules/social/blast-workspace/codec.ts").WorkspaceWriteEnvelope[] = [];
  const times: number[] = [];
  const api = {
    read: async () => saved(),
    write: async (write: import("@blast/core/modules/social/blast-workspace/codec.ts").WorkspaceWriteEnvelope) => {
      writes.push(write);
      times.push(Date.now());
      if (writes.length === 1)
        throw new WorkspaceSyncError("rate_limited", true, 60_000);
      return ack(write.sequence);
    },
  };
  const first = createAccountWorkspace({
    accountId: "A",
    writerId: "deadline",
    storage: local,
    api,
  });
  await first.start();
  first.getSnapshot().store!.setCapacity(2);
  t.mock.timers.tick(500);
  await settled();
  first.getSnapshot().store!.setCapacity(3);
  await first.flush();
  await first.retry();
  t.mock.timers.tick(2000);
  await settled();
  assert.equal(
    writes.length,
    1,
    "edits/flush/reconnect must not bypass Retry-After",
  );
  first.dispose();
  const next = createAccountWorkspace({
    accountId: "A",
    writerId: "deadline",
    storage: local,
    api,
  });
  await next.start();
  await next.retry();
  await next.flush();
  t.mock.timers.tick(57_999);
  await settled();
  assert.equal(writes.length, 1, "reload must retain the server deadline");
  t.mock.timers.tick(1);
  await settled();
  assert.deepEqual(times, [10_500, 70_500]);
  assert.deepEqual(
    writes[1],
    writes[0],
    "resolve the immutable uncertain identity first",
  );
  t.mock.timers.tick(2000);
  await settled();
  assert.equal(writes[2]!.sequence, 2);
  assert.equal(writes[2]!.workspace.desktop_capacity, 3);
  assert.equal(next.getSnapshot().sync, "synced");
  next.dispose();
});
test("edits journal immediately, debounce 500ms, coalesce at 2s, and old acknowledgement never syncs a newer edit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const local = storage();
  const writes: import("@blast/core/modules/social/blast-workspace/codec.ts").WorkspaceWriteEnvelope[] = [];
  let accept: (value: ReturnType<typeof ack>) => void = () => {};
  const account = createAccountWorkspace({
    accountId: "A",
    writerId: "timer",
    storage: local,
    api: {
      read: async () => saved(),
      write: (write) => {
        writes.push(write);
        return new Promise((resolve) => {
          accept = resolve;
        });
      },
    },
  });
  await account.start();
  const store = account.getSnapshot().store!;
  store.setDataCollapsed(true);
  assert.equal(account.getSnapshot().sync, "local");
  assert.ok(
    [...local.values.values()].some((bytes) =>
      bytes.includes('"collapsed":true'),
    ),
  );
  t.mock.timers.tick(499);
  await settled();
  assert.equal(writes.length, 0);
  t.mock.timers.tick(1);
  await settled();
  assert.equal(writes.length, 1);
  store.setCapacity(2);
  store.setCapacity(3);
  accept(ack(1));
  await settled();
  assert.notEqual(account.getSnapshot().sync, "synced");
  t.mock.timers.tick(1999);
  await settled();
  assert.equal(writes.length, 1);
  t.mock.timers.tick(1);
  await settled();
  assert.equal(writes.length, 2);
  assert.equal(writes[1]!.workspace.desktop_capacity, 3);
  accept(ack(2));
  await settled();
  assert.equal(account.getSnapshot().sync, "synced");
  account.dispose();
});

test("concurrent initialization conflict reads the winner instead of installing guest", async () => {
  const { WorkspaceSyncError } = await import("./account-sync");
  let reads = 0;
  const winner = { ...emptyWorkspace(), desktop_capacity: 2, desktop_slots: [null,null] };
  const account = createAccountWorkspace({
    accountId: "A",
    writerId: "race",
    storage: storage(),
    guest: () => emptyWorkspace(),
    api: {
      read: async () =>
        ++reads === 1
          ? { ...saved(), revision: "0", workspace: null }
          : saved(winner),
      write: async () => {
        throw new WorkspaceSyncError("workspace_exists");
      },
    },
  });
  await account.start();
  assert.equal(reads, 2);
  assert.deepEqual(account.getSnapshot().store!.getSnapshot(), winner);
  account.dispose();
});

test("continuous input dispatches newest by five seconds and exit flush respects the two second spacing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const writes: number[] = [];
  const account = createAccountWorkspace({
    accountId: "A",
    writerId: "continuous",
    storage: storage(),
    api: {
      read: async () => saved(),
      write: async (write) => {
        writes.push(Date.now());
        return ack(write.sequence);
      },
    },
  });
  await account.start();
  const store = account.getSnapshot().store!;
  for (let n = 0; n < 12; n++) {
    store.setCapacity(1 + (n % 4));
    t.mock.timers.tick(400);
    await settled();
  }
  store.setCapacity(1);
  t.mock.timers.tick(199);
  await settled();
  assert.equal(writes.length, 0);
  t.mock.timers.tick(1);
  await settled();
  assert.deepEqual(writes, [15_000]);
  store.setCapacity(2);
  await account.flush();
  assert.equal(writes.length, 1);
  t.mock.timers.tick(2000);
  await settled();
  assert.equal(writes.length, 2);
  account.dispose();
});

test("network retries are bounded, retain the exact uncertain identity through reload, and recover before newer edits", async (t) => {
  const { WorkspaceSyncError } = await import("./account-sync");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const local = storage();
  const writes: import("@blast/core/modules/social/blast-workspace/codec.ts").WorkspaceWriteEnvelope[] = [];
  let offline = true;
  const api = {
    read: async () => saved(),
    write: async (write: import("@blast/core/modules/social/blast-workspace/codec.ts").WorkspaceWriteEnvelope) => {
      writes.push(write);
      if (offline)
        throw new WorkspaceSyncError("service_unavailable", true, 3000);
      return ack(write.sequence);
    },
  };
  const first = createAccountWorkspace({
    accountId: "A",
    writerId: "reload",
    storage: local,
    api,
  });
  await first.start();
  first.getSnapshot().store!.setCapacity(2);
  t.mock.timers.tick(500);
  await settled();
  first.getSnapshot().store!.setCapacity(3);
  for (let n = 0; n < 6; n++) {
    t.mock.timers.tick(40_000);
    await settled();
  }
  assert.equal(writes.length, 4);
  assert.ok(
    writes.every(
      (write) => JSON.stringify(write) === JSON.stringify(writes[0]),
    ),
  );
  first.dispose();
  offline = false;
  const next = createAccountWorkspace({
    accountId: "A",
    writerId: "reload",
    storage: local,
    api,
  });
  await next.start();
  assert.deepEqual(writes[4], writes[0]);
  assert.equal(next.getSnapshot().store!.getSnapshot().desktop_capacity, 3);
  t.mock.timers.tick(2000);
  await settled();
  assert.equal(writes[5]!.sequence, 2);
  assert.equal(writes[5]!.workspace.desktop_capacity, 3);
  assert.equal(next.getSnapshot().sync, "synced");
  next.dispose();
});

test("fallback remains stable after retry and terminal schema failures do not retry unchanged", async (t) => {
  const { WorkspaceSyncError } = await import("./account-sync");
  const { workspaceJournalKey } = await import("./journal");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const local = storage();
  const cached = { ...emptyWorkspace(), desktop_capacity: 2, desktop_slots: [null,null] };
  local.setItem(
    workspaceJournalKey({
      actor: { kind: "account", account_id: "A" },
      chain: "sui",
      network: "mainnet",
    }),
    JSON.stringify(cached),
  );
  let offline = true;
  let reads = 0;
  let writes = 0;
  const account = createAccountWorkspace({
    accountId: "A",
    writerId: "fallback",
    storage: local,
    api: {
      read: async () => {
        reads++;
        if (offline) throw new Error("offline");
        return saved();
      },
      write: async () => {
        writes++;
        throw new WorkspaceSyncError("workspace_schema_unsupported");
      },
    },
  });
  await account.start();
  assert.deepEqual(account.getSnapshot().store!.getSnapshot(), cached);
  offline = false;
  await account.retry();
  assert.equal(reads, 2);
  assert.deepEqual(account.getSnapshot().store!.getSnapshot(), cached);
  assert.notEqual(account.getSnapshot().sync, "synced");
  account.getSnapshot().store!.setCapacity(3);
  t.mock.timers.tick(500);
  await settled();
  t.mock.timers.tick(100_000);
  await settled();
  assert.equal(writes, 1);
  account.dispose();
});

test("explicit retry recovers expired auth with the same uncertain write identity", async (t) => {
  const { WorkspaceSyncError } = await import("./account-sync");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let expired = true;
  const writes: import("@blast/core/modules/social/blast-workspace/codec.ts").WorkspaceWriteEnvelope[] = [];
  const account = createAccountWorkspace({
    accountId: "A",
    writerId: "auth",
    storage: storage(),
    api: {
      read: async () => saved(),
      write: async (write) => {
        writes.push(write);
        if (expired) throw new WorkspaceSyncError("unauthorized");
        return ack(write.sequence);
      },
    },
  });
  await account.start();
  account.getSnapshot().store!.setCapacity(2);
  t.mock.timers.tick(500);
  await settled();
  assert.equal(account.getSnapshot().sync, "error");
  expired = false;
  t.mock.timers.tick(2000);
  await account.retry();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(account.getSnapshot().sync, "synced");
  account.dispose();
});

test("blocked auth and exhausted network errors remain visible through later edits until explicit recovery", async (t) => {
  const { WorkspaceSyncError } = await import("./account-sync");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  for (const retryable of [false, true]) {
    const local = storage();
    const writes: import("@blast/core/modules/social/blast-workspace/codec.ts").WorkspaceWriteEnvelope[] = [];
    let failing = true;
    const account = createAccountWorkspace({
      accountId: "A",
      writerId: `blocked-${retryable}`,
      storage: local,
      api: {
        read: async () => saved(),
        write: async (write) => {
          writes.push(write);
          if (failing)
            throw new WorkspaceSyncError(
              retryable ? "network_unavailable" : "unauthorized",
              retryable,
            );
          return ack(write.sequence);
        },
      },
    });
    await account.start();
    account.getSnapshot().store!.setCapacity(2);
    t.mock.timers.tick(500);
    await settled();
    if (retryable)
      for (let n = 0; n < 4; n++) {
        t.mock.timers.tick(40_000);
        await settled();
      }
    const failure = account.getSnapshot().reason;
    const count = writes.length;
    account.getSnapshot().store!.setCapacity(3);
    assert.equal(
      account.getSnapshot().sync,
      "error",
      "blocked saving must retain visible recovery after an edit",
    );
    assert.equal(account.getSnapshot().reason, failure);
    assert.ok(
      [...local.values.values()].some((bytes) =>
        bytes.includes('"desktop_capacity":3'),
      ),
    );
    t.mock.timers.tick(40_000);
    await settled();
    assert.equal(
      writes.length,
      count,
      "new edits do not silently restart a blocked cycle",
    );
    failing = false;
    await account.retry();
    assert.deepEqual(writes.at(-1), writes[0]);
    t.mock.timers.tick(2000);
    await settled();
    assert.equal(writes.at(-1)!.workspace.desktop_capacity, 3);
    assert.equal(account.getSnapshot().sync, "synced");
    account.dispose();
  }
});

test("a terminal rejected payload waits for a changed setup before dispatching a new sequence", async (t) => {
  const { WorkspaceSyncError } = await import("./account-sync");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const writes: import("@blast/core/modules/social/blast-workspace/codec.ts").WorkspaceWriteEnvelope[] = [];
  const account = createAccountWorkspace({
    accountId: "A",
    writerId: "corrected",
    storage: storage(),
    api: {
      read: async () => saved(),
      write: async (write) => {
        writes.push(write);
        if (writes.length === 1) throw new WorkspaceSyncError("body_too_large");
        return ack(write.sequence);
      },
    },
  });
  await account.start();
  account.getSnapshot().store!.setCapacity(2);
  t.mock.timers.tick(500);
  await settled();
  await account.retry();
  t.mock.timers.tick(5000);
  await settled();
  assert.equal(writes.length, 1);
  account.getSnapshot().store!.setCapacity(1);
  t.mock.timers.tick(500);
  await settled();
  assert.equal(writes.length, 2);
  assert.equal(writes[1]!.sequence, 2);
  assert.equal(account.getSnapshot().sync, "synced");
  account.dispose();
});

test("an unreadable outbox is preserved byte-for-byte through explicit retry", async () => {
  const { workspaceJournalKey } = await import("./journal");
  const local = storage();
  const key =
    workspaceJournalKey({
      actor: { kind: "account", account_id: "A" },
      chain: "sui",
      network: "mainnet",
    }) + ":outbox:corrupt";
  const original = '{"version":99,"future":"keep for recovery"}';
  local.setItem(key, original);
  const account = createAccountWorkspace({
    accountId: "A",
    writerId: "corrupt",
    storage: local,
    api: {
      read: async () => saved(),
      write: async (write) => ack(write.sequence),
    },
  });
  await account.start();
  assert.equal(account.getSnapshot().phase, "error");
  await account.retry();
  assert.equal(local.getItem(key), original);
  account.dispose();
});

test("reload retains the two-second dispatch spacing for an uncertain write", async (t) => {
  const { WorkspaceSyncError } = await import("./account-sync");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const local = storage();
  let count = 0;
  let offline = true;
  const api = {
    read: async () => saved(),
    write: async (write: import("@blast/core/modules/social/blast-workspace/codec.ts").WorkspaceWriteEnvelope) => {
      count++;
      if (offline) throw new WorkspaceSyncError("network_unavailable", true);
      return ack(write.sequence);
    },
  };
  const first = createAccountWorkspace({
    accountId: "A",
    writerId: "spacing",
    storage: local,
    api,
  });
  await first.start();
  first.getSnapshot().store!.setCapacity(2);
  t.mock.timers.tick(500);
  await settled();
  assert.equal(count, 1);
  first.dispose();
  offline = false;
  t.mock.timers.tick(500);
  const next = createAccountWorkspace({
    accountId: "A",
    writerId: "spacing",
    storage: local,
    api,
  });
  await next.start();
  assert.equal(count, 1);
  t.mock.timers.tick(1499);
  await settled();
  assert.equal(count, 1);
  t.mock.timers.tick(1);
  await settled();
  assert.equal(count, 2);
  next.dispose();
});

test("disposed owner generations ignore delayed reads", async () => {
  let resolve: (value: ReturnType<typeof saved>) => void = () => {};
  let notifications = 0;
  const account = createAccountWorkspace({
    accountId: "A",
    writerId: "old-entry",
    storage: storage(),
    api: {
      read: () =>
        new Promise((accept) => {
          resolve = accept;
        }),
      write: async (write) => ack(write.sequence),
    },
  });
  account.subscribe(() => notifications++);
  const entering = account.start();
  await settled();
  account.dispose();
  resolve(saved());
  await entering;
  assert.equal(account.getSnapshot().store, undefined);
  assert.equal(notifications, 0);
});

test("returning to the original authenticated owner recovers its preserved outbox without retargeting it", async (t) => {
  const { WorkspaceSyncError } = await import("./account-sync");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const local = storage();
  let ownerMatches = false;
  const writes: import("@blast/core/modules/social/blast-workspace/codec.ts").WorkspaceWriteEnvelope[] = [];
  const api = {
    read: async () => saved(),
    write: async (write: import("@blast/core/modules/social/blast-workspace/codec.ts").WorkspaceWriteEnvelope) => {
      writes.push(write);
      if (!ownerMatches) throw new WorkspaceSyncError("owner_changed");
      return ack(write.sequence);
    },
  };
  const a = createAccountWorkspace({
    accountId: "A",
    writerId: "return-owner",
    storage: local,
    api,
  });
  await a.start();
  a.getSnapshot().store!.setCapacity(2);
  t.mock.timers.tick(500);
  await settled();
  a.dispose();
  t.mock.timers.tick(2000);
  ownerMatches = true;
  const returned = createAccountWorkspace({
    accountId: "A",
    writerId: "return-owner",
    storage: local,
    api,
  });
  await returned.start();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  returned.dispose();
});


test("cached presentation appears during delayed hydration without installing or writing defaults", async () => {
  const local = storage();
  const cached = { ...emptyWorkspace(), presentation: "compare" as const, data: { ...emptyWorkspace().data, collapsed: true } };
  const encoded = encodeWorkspace(cached); assert.ok(encoded.ok);
  local.values.set(workspaceJournalKey({ actor: { kind: "account", account_id: "A" }, chain: "sui", network: "mainnet" }), encoded.bytes);
  let finish!: (value: ReturnType<typeof saved>) => void;
  let writes = 0;
  const account = createAccountWorkspace({ accountId: "A", writerId: "tab-a", storage: local,
    api: { read: () => new Promise(resolve => { finish = resolve; }), write: async () => { writes++; throw new Error("Unexpected write"); } } });
  const starting = account.start();
  await Promise.resolve();
  assert.equal(account.getSnapshot().phase, "loading");
  assert.deepEqual(account.getSnapshot().preview, { ...cached, presentation: "focus" });
  assert.equal(account.getSnapshot().store, undefined);
  assert.equal(writes, 0);
  finish(saved()); await starting;
  assert.deepEqual(account.getSnapshot().store!.getSnapshot(), emptyWorkspace());
  assert.equal(writes, 0);
  account.dispose();
});
