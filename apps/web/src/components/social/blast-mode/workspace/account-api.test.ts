import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceApi } from "./account-api";
import { emptyWorkspace } from "@blast/core/modules/social/blast-workspace/setup.ts";
const write = {
  initialize_if_absent: false,
  writer_id: "a",
  sequence: 1,
  workspace: emptyWorkspace(),
};

test("private writes verify the stable account and never send an old owner's setup under new auth", async () => {
  const calls: string[] = [];
  const api = createWorkspaceApi({
    accountId: "A",
    getAccessToken: async () => "token-b",
    fetch: async (url, init) => {
      calls.push(String(url));
      assert.equal(
        (init!.headers as Record<string, string>).authorization,
        "Bearer token-b",
      );
      return Response.json({ account: { account_id: "B" } });
    },
  });
  await assert.rejects(api.write(write), /owner_changed/);
  assert.deepEqual(calls, ["/api/social/me"]);
});

test("a save under a token already answered as this account skips the account read; a new token checks again", async () => {
  const calls: string[] = [];
  let token = "token-a";
  const api = createWorkspaceApi({
    accountId: "A",
    getAccessToken: async () => token,
    fetch: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url) === "/api/social/me") return Response.json({ account: { account_id: "A" } });
      return Response.json({ account_id: "A", revision: "1", saved_at_ms: 1, sequence: 1 });
    },
  });
  await api.write(write);
  await api.write(write);
  token = "token-b";
  await api.write(write);
  assert.deepEqual(calls, [
    "GET /api/social/me",
    "PUT /api/social/me/blast-workspace",
    "PUT /api/social/me/blast-workspace",
    "GET /api/social/me",
    "PUT /api/social/me/blast-workspace",
  ]);
});
