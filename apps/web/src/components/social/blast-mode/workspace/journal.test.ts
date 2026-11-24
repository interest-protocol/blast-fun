import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  createWorkspaceJournal,
  createBrowserWorkspaceJournal,
  workspaceJournalKey,
  type JournalScope,
} from "./journal";

const guest: JournalScope = {
  actor: { kind: "guest" },
  chain: "sui",
  network: "mainnet",
};
const panel = {
  panel_id: "A",
  chain: "sui",
  network: "mainnet",
  coin_type: "0x2::coin::A",
  presale_id: null,
} as const;

test("a DOM input edit journals its final text synchronously before a fresh instance reloads", () => {
  const dom = new JSDOM('<input id="amount">', { url: "https://blast.test" });
  try {
    const journal = createWorkspaceJournal({
      scope: guest,
      storage: dom.window.localStorage,
    });
    assert.equal(journal.restore.status, "empty");
    journal.store.add(panel);
    const input = dom.window.document.querySelector("input")!;
    input.addEventListener("input", () => {
      const setup = journal.store.getSnapshot().panels.A!.coin;
      journal.store.patchPanel("A", {
        coin: {
          ...setup,
          trade: { ...setup.trade, buy: { typed: input.value, mode: "typed" } },
        },
      });
    });
    input.value = "0000123.";
    input.dispatchEvent(new dom.window.Event("input"));
    const reloaded = createWorkspaceJournal({
      scope: guest,
      storage: dom.window.localStorage,
    });
    assert.equal(
      reloaded.store.getSnapshot().panels.A!.coin.trade.buy.typed,
      "0000123.",
    );
    assert.equal(journal.getPersistence().ok, true);
    journal.dispose();
    reloaded.dispose();
  } finally {
    dom.window.close();
  }
});

test("localStorage quota failure preserves the last saved bytes and the newer in-memory input", () => {
  const dom = new JSDOM("", { url: "https://blast.test", storageQuota: 6000 });
  try {
    const journal = createWorkspaceJournal({
      scope: guest,
      storage: dom.window.localStorage,
    });
    journal.store.add(panel);
    const saved = dom.window.localStorage.getItem(journal.key);
    const setup = journal.store.getSnapshot().panels.A!.coin;
    journal.store.patchPanel("A", {
      coin: {
        ...setup,
        trade: {
          ...setup.trade,
          buy: { typed: "9".repeat(5000), mode: "typed" },
        },
      },
    });
    assert.equal(journal.getPersistence().ok, false);
    assert.equal(dom.window.localStorage.getItem(journal.key), saved);
    assert.equal(
      journal.store.getSnapshot().panels.A!.coin.trade.buy.typed.length,
      5000,
    );
    const failed = journal.getPersistence();
    if (!failed.ok) assert.equal(failed.original_bytes, saved);
    journal.dispose();
  } finally {
    dom.window.close();
  }
});

test("future and malformed storage require recovery and edits never overwrite their original bytes", () => {
  const dom = new JSDOM("", { url: "https://blast.test" });
  try {
    for (const bytes of [
      "{invalid",
      '{"schema_version":2,"future_setup":"precious"}',
    ]) {
      const key = workspaceJournalKey(guest);
      dom.window.localStorage.setItem(key, bytes);
      const journal = createWorkspaceJournal({
        scope: guest,
        storage: dom.window.localStorage,
      });
      assert.equal(journal.restore.status, "recovery_required");
      journal.store.add(panel);
      assert.equal(journal.getPersistence().ok, false);
      assert.equal(journal.flush().ok, false);
      assert.equal(dom.window.localStorage.getItem(key), bytes);
      assert.equal(journal.store.getSnapshot().visible_order[0], "A");
      journal.dispose();
    }
  } finally {
    dom.window.close();
  }
});

for (const [label, bytes, reason] of [
  ["malformed", "{broken after entry", "malformed_json"],
  [
    "future",
    '{"schema_version":2,"future":"keep exact bytes"}',
    "unsupported_schema",
  ],
] as const) {
  for (const restored of [false, true]) {
    test(`${label} bytes introduced after ${restored ? "restore" : "empty entry"} survive later edits and flushes`, () => {
      const dom = new JSDOM("", { url: "https://blast.test" });
      try {
        if (restored) {
          const initial = createWorkspaceJournal({
            scope: guest,
            storage: dom.window.localStorage,
          });
          initial.store.add(panel);
          initial.dispose();
        }
        const journal = createWorkspaceJournal({
          scope: guest,
          storage: dom.window.localStorage,
        });
        assert.equal(journal.restore.status, restored ? "restored" : "empty");
        journal.store.add(panel);
        dom.window.localStorage.setItem(journal.key, bytes);
        journal.store.setDataCollapsed(true);
        const expected = { ok: false, reason, original_bytes: bytes };
        assert.deepEqual(journal.getPersistence(), expected);
        assert.deepEqual(journal.flush(), expected);
        assert.equal(dom.window.localStorage.getItem(journal.key), bytes);
        assert.equal(journal.store.getSnapshot().data.collapsed, true);
        assert.deepEqual(journal.store.getSnapshot().visible_order, ["A"]);
        journal.dispose();
      } finally {
        dom.window.close();
      }
    });
  }
}

test("storage becoming unreadable after restore preserves saved bytes and the newer memory setup", () => {
  const dom = new JSDOM("", { url: "https://blast.test" });
  try {
    const initial = createWorkspaceJournal({
      scope: guest,
      storage: dom.window.localStorage,
    });
    initial.store.add(panel);
    const bytes = dom.window.localStorage.getItem(initial.key);
    initial.dispose();
    let blocked = false;
    const journal = createWorkspaceJournal({
      scope: guest,
      storage: {
        getItem(key) {
          if (blocked)
            throw new dom.window.DOMException("Blocked", "SecurityError");
          return dom.window.localStorage.getItem(key);
        },
        setItem: (key, value) => dom.window.localStorage.setItem(key, value),
      },
    });
    assert.equal(journal.restore.status, "restored");
    blocked = true;
    journal.store.setDataCollapsed(true);
    assert.deepEqual(journal.getPersistence(), {
      ok: false,
      reason: "storage_read_failed",
      original_bytes: null,
    });
    assert.equal(journal.flush().ok, false);
    assert.equal(dom.window.localStorage.getItem(journal.key), bytes);
    assert.equal(journal.store.getSnapshot().data.collapsed, true);
    journal.dispose();
  } finally {
    dom.window.close();
  }
});

test("a concurrently saved supported snapshot wins over a stale tab without merging into memory", () => {
  const dom = new JSDOM("", { url: "https://blast.test" });
  try {
    const journal = createWorkspaceJournal({
      scope: guest,
      storage: dom.window.localStorage,
    });
    journal.store.add(panel);
    const concurrent = createWorkspaceJournal({
      scope: guest,
      storage: dom.window.localStorage,
    });
    concurrent.store.add({
      ...panel,
      panel_id: "B",
      coin_type: "0x2::coin::B",
    });
    journal.store.setDataCollapsed(true);
    const reloaded = createWorkspaceJournal({
      scope: guest,
      storage: dom.window.localStorage,
    });
    assert.equal(journal.getPersistence().ok, false);
    assert.deepEqual(reloaded.store.getSnapshot(), concurrent.store.getSnapshot());
    assert.deepEqual(reloaded.store.getSnapshot().visible_order, ["A", "B"]);
    reloaded.dispose();
    concurrent.dispose();
    journal.dispose();
  } finally {
    dom.window.close();
  }
});

test("guest, account and network journals remain separate through account disposal and logout", () => {
  const dom = new JSDOM("", { url: "https://blast.test" });
  try {
    const storage = dom.window.localStorage;
    const guestJournal = createWorkspaceJournal({ scope: guest, storage });
    guestJournal.store.setDataCollapsed(true);
    const guestBytes = storage.getItem(guestJournal.key);
    guestJournal.dispose();
    const account: JournalScope = {
      ...guest,
      actor: { kind: "account", account_id: "account:1" },
    };
    const accountJournal = createWorkspaceJournal({ scope: account, storage });
    accountJournal.store.add(panel);
    assert.notEqual(accountJournal.key, workspaceJournalKey(guest));
    assert.notEqual(
      accountJournal.key,
      workspaceJournalKey({ ...account, network: "testnet" }),
    );
    assert.notEqual(
      accountJournal.key,
      workspaceJournalKey({
        ...account,
        actor: { kind: "account", account_id: "account:2" },
      }),
    );
    accountJournal.dispose();
    const loggedOut = createWorkspaceJournal({ scope: guest, storage });
    assert.deepEqual(loggedOut.store.getSnapshot().visible_order, []);
    assert.equal(loggedOut.store.getSnapshot().data.collapsed, true);
    assert.equal(storage.getItem(loggedOut.key), guestBytes);
    loggedOut.dispose();
  } finally {
    dom.window.close();
  }
});

test("completed reorders persist once, while cancelled drags do not change saved setup", () => {
  const dom = new JSDOM("", { url: "https://blast.test" });
  try {
    const journal = createWorkspaceJournal({
      scope: guest,
      storage: dom.window.localStorage,
    });
    journal.store.add(panel);
    journal.store.add({ ...panel, panel_id: "B", coin_type: "0x2::coin::B" });
    const bytes = dom.window.localStorage.getItem(journal.key);
    journal.store.reorder(["A", "B"], false);
    assert.equal(dom.window.localStorage.getItem(journal.key), bytes);
    journal.store.reorder(["A", "B"]);
    const restored = createWorkspaceJournal({
      scope: guest,
      storage: dom.window.localStorage,
    });
    assert.deepEqual(restored.store.getSnapshot().visible_order, ["A", "B"]);
    restored.dispose();
    journal.dispose();
  } finally {
    dom.window.close();
  }
});

test("a blocked browser storage getter reports recovery and never claims persistence", () => {
  const dom = new JSDOM("", { url: "file:///blocked.html" });
  try {
    const journal = createBrowserWorkspaceJournal(
      guest,
      dom.window as unknown as Pick<Window, "localStorage">,
    );
    assert.equal(journal.restore.status, "recovery_required");
    assert.equal(journal.getPersistence().ok, false);
    journal.store.add(panel);
    assert.deepEqual(journal.store.getSnapshot().visible_order, ["A"]);
    assert.equal(journal.flush().ok, false);
    journal.dispose();
  } finally {
    dom.window.close();
  }
});

test("a failed synchronous write can be retried without dropping the newer memory setup", () => {
  const dom = new JSDOM("", { url: "https://blast.test" });
  try {
    let blocked = true;
    const storage = {
      getItem: (key: string) => dom.window.localStorage.getItem(key),
      setItem(key: string, value: string) {
        if (blocked)
          throw new dom.window.DOMException("Blocked", "SecurityError");
        dom.window.localStorage.setItem(key, value);
      },
    };
    const journal = createWorkspaceJournal({ scope: guest, storage });
    journal.store.add(panel);
    assert.equal(journal.getPersistence().ok, false);
    blocked = false;
    assert.deepEqual(journal.flush(), { ok: true });
    const restored = createWorkspaceJournal({ scope: guest, storage });
    assert.deepEqual(restored.store.getSnapshot().visible_order, ["A"]);
    restored.dispose();
    journal.dispose();
  } finally {
    dom.window.close();
  }
});

test("recovery status cannot be changed by a consumer to authorize an overwrite", () => {
  const dom = new JSDOM("", { url: "https://blast.test" });
  try {
    const bytes = '{"schema_version":2,"future":"keep"}';
    dom.window.localStorage.setItem(workspaceJournalKey(guest), bytes);
    const journal = createWorkspaceJournal({
      scope: guest,
      storage: dom.window.localStorage,
    });
    assert.throws(() => Object.assign(journal.restore, { status: "empty" }));
    assert.throws(() => Object.assign(journal.getPersistence(), { ok: true }));
    journal.store.add(panel);
    assert.equal(dom.window.localStorage.getItem(journal.key), bytes);
    journal.dispose();
  } finally {
    dom.window.close();
  }
});

test("an older tab cannot overwrite a newer saved workspace, including on later retry", () => {
  const dom = new JSDOM("", { url: "https://blast.test" });
  const first = createWorkspaceJournal({ scope: guest, storage: dom.window.localStorage });
  first.store.add(panel);
  const stale = createWorkspaceJournal({ scope: guest, storage: dom.window.localStorage });
  try {
    first.store.setDataCollapsed(true);
    const newer = dom.window.localStorage.getItem(first.key);
    stale.store.setLayout({ order: ["trade", "chart", "activity", "details"], hidden: [], split: 55 });
    assert.deepEqual(stale.getPersistence(), { ok: false, reason: "workspace_changed_in_another_tab", original_bytes: newer });
    assert.equal(stale.flush().ok, false);
    assert.equal(dom.window.localStorage.getItem(first.key), newer);
    assert.equal(stale.store.getSnapshot().layout?.split, 55);
    assert.equal(stale.store.getSnapshot().data.collapsed, false);
  } finally { first.dispose(); stale.dispose(); dom.window.close(); }
});
