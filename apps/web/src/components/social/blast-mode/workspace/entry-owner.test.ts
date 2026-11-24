import assert from "node:assert/strict";
import test from "node:test";
import { workspaceOwnerFromSession } from "./entry-owner";

test("only a settled signed-out session permits guest storage; accounts, pending and errors stay separate", () => {
  assert.deepEqual(
    workspaceOwnerFromSession({
      status: "signed_out",
      account: null,
      sessionStatus: "signed_out",
    }),
    { status: "ready", owner: { kind: "guest" } },
  );
  assert.deepEqual(
    workspaceOwnerFromSession({ status: "loading", account: null }),
    { status: "pending" },
  );
  assert.deepEqual(
    workspaceOwnerFromSession({ status: "error", account: null }),
    { status: "error" },
  );
  assert.deepEqual(
    workspaceOwnerFromSession({
      status: "ready",
      account: { account_id: "account-1" },
    }),
    { status: "ready", owner: { kind: "account", account_id: "account-1" } },
  );
  assert.deepEqual(
    workspaceOwnerFromSession({
      status: "ready",
      account: null,
      sessionStatus: "authenticated",
    }),
    { status: "ready", owner: { kind: "guest" } },
  );
});

test("a refused authenticated read and missing provenance never confirm a guest", () => {
  for (const sessionStatus of [undefined, "refused", "pending"] as const) {
    const owner = workspaceOwnerFromSession({
      status: "signed_out",
      account: null,
      sessionStatus,
    });
    assert.notEqual(owner.status, "ready");
  }
});

test("entry keeps guest through sign-in, keeps a wallet's stable account, and ends on established owner switch", async () => {
  const { workspaceEntryOwner } = await import("./entry-owner");
  const guest = { kind: "guest" } as const;
  const account = { kind: "account", account_id: "A" } as const;
  assert.deepEqual(
    workspaceEntryOwner(guest, { status: "ready", owner: account }),
    { status: "ready", owner: guest },
  );
  assert.deepEqual(
    workspaceEntryOwner(account, { status: "ready", owner: account }),
    { status: "ready", owner: account },
  );
  assert.equal(
    workspaceEntryOwner(account, {
      status: "ready",
      owner: { kind: "account", account_id: "B" },
    }).status,
    "ended",
  );
  assert.equal(
    workspaceEntryOwner(account, { status: "ready", owner: guest }).status,
    "ended",
  );
});
