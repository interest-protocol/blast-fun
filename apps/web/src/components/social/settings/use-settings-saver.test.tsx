import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { DEFAULT_NOTIFICATION_PREFERENCES, type SocialSettingsResponse } from "@blast/core/modules/social/contracts/settings.ts";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import type { TokenSource } from "#web/components/social/social-api.ts";

const { document } = installTestDom();
const { act, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useSettingsSaver } = await import("./use-settings-saver.ts");

const SETTINGS: SocialSettingsResponse = {
  privacy: "public", sharing_since_ms: 1, commit_too_coin_type: null, blast_mode_confirm_actions: false, public_portfolio: false,
  explorer: "suiscan", sound: null, notifications: DEFAULT_NOTIFICATION_PREFERENCES,
};

async function mount(t: TestContext, source: TokenSource | undefined = async () => "token-a") {
  const realFetch = globalThis.fetch;
  const requests: { init: RequestInit | undefined; answer(response: Response): void }[] = [];
  globalThis.fetch = (_input, init) => new Promise<Response>((answer) => { requests.push({ init, answer }); });
  const saved: { accountId: string; settings: SocialSettingsResponse }[] = [];
  const failed: string[] = [];
  let shown!: ReturnType<typeof useSettingsSaver>;
  function Probe({ accountId, getAccessToken }: { accountId: string; getAccessToken: TokenSource | undefined }) {
    const input = {
      accountId, getAccessToken, stored: SETTINGS,
      onStored: (settings: SocialSettingsResponse) => { saved.push({ accountId, settings }); },
      onFailed: (message: string) => { failed.push(message); },
    };
    shown = useSettingsSaver(input);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (accountId: string, getAccessToken: TokenSource | undefined) => {
    await act(async () => { root.render(<StrictMode><Probe accountId={accountId} getAccessToken={getAccessToken} /></StrictMode>); });
  };
  const unmount = async () => { await act(async () => { root.unmount(); }); };
  t.after(async () => {
    await unmount();
    container.remove();
    globalThis.fetch = realFetch;
  });
  await render("a", source);
  return { saved, failed, requests, render, unmount, shown: () => shown };
}

test("an account switch discards its queued changes and an earlier save cannot update the new account", async (t) => {
  const page = await mount(t);
  let confirmations = 0;
  await act(async () => {
    page.shown().change({ patch: { private: true }, onSaved: () => { confirmations += 1; } });
    page.shown().change({ patch: { explorer: "suivision" } });
  });
  assert.equal(page.requests.length, 1, "writes are serialized");
  await page.render("b", async () => "token-b");
  assert.deepEqual(page.shown().shown, SETTINGS, "the earlier account's optimistic changes do not render");
  await act(async () => { page.requests[0]!.answer(Response.json({ ...SETTINGS, privacy: "private" })); });
  assert.deepEqual(page.saved, [], "the earlier answer never reaches the new account's cache");
  assert.equal(confirmations, 0);
  assert.equal(page.requests.length, 1, "the earlier account's queued changes are discarded");
});

test("the new account's queued save waits for the earlier request and keeps its own pending state", async (t) => {
  const page = await mount(t);
  await act(async () => { page.shown().change({ patch: { private: true } }); });
  await page.render("b", async () => "token-b");
  await act(async () => { page.shown().change({ patch: { public_portfolio: true } }); });
  await act(async () => { page.requests[0]!.answer(Response.json({ ...SETTINGS, privacy: "private" })); });
  assert.deepEqual(page.saved, []);
  assert.equal(page.requests.length, 2);
  assert.equal(page.shown().shown?.public_portfolio, true);
  assert.equal(page.shown().shown?.privacy, "public");
  assert.equal(new Headers(page.requests[1]!.init?.headers).get("authorization"), "Bearer token-b");
  assert.deepEqual(JSON.parse(String(page.requests[1]!.init?.body)), { public_portfolio: true });
  await act(async () => { page.requests[1]!.answer(Response.json({ ...SETTINGS, public_portfolio: true })); });
  assert.deepEqual(page.saved, [{ accountId: "b", settings: { ...SETTINGS, public_portfolio: true } }]);
  assert.equal(page.shown().saving, false);
});

test("without a session source an unsaved optimistic change rolls back and reports the failure", async (t) => {
  const page = await mount(t);
  await page.render("a", undefined);
  await act(async () => { page.shown().change({ patch: { private: true } }); });
  assert.deepEqual(page.shown().shown, SETTINGS);
  assert.equal(page.requests.length, 0);
  assert.equal(page.failed.length, 1);
  assert.match(page.failed[0]!, /session ended.*Nothing was saved/);
  assert.equal(page.shown().saving, false);
});

test("an unmounted settings page drops queued changes and its later answer cannot update the shared cache", async (t) => {
  const page = await mount(t);
  await act(async () => {
    page.shown().change({ patch: { private: true } });
    page.shown().change({ patch: { explorer: "suivision" } });
  });
  await page.unmount();
  await act(async () => { page.requests[0]!.answer(Response.json({ ...SETTINGS, privacy: "private" })); });
  assert.deepEqual(page.saved, []);
  assert.equal(page.requests.length, 1);
});

test("changes queued by the same account merge into one following save, with later values winning", async (t) => {
  const page = await mount(t);
  await act(async () => {
    page.shown().change({ patch: { private: true } });
    page.shown().change({ patch: { explorer: "suivision", notifications: { opens_soon: false } } });
    page.shown().change({ patch: { explorer: "suiscan", notifications: { funded: false } } });
  });
  await act(async () => { page.requests[0]!.answer(Response.json({ ...SETTINGS, privacy: "private" })); });
  assert.equal(page.requests.length, 2);
  assert.deepEqual(JSON.parse(String(page.requests[1]!.init?.body)), { explorer: "suiscan", notifications: { opens_soon: false, funded: false } });
  await act(async () => { page.requests[1]!.answer(Response.json(SETTINGS)); });
  assert.equal(page.saved.length, 2);
  assert.deepEqual(page.failed, []);
  assert.equal(page.shown().saving, false);
});

test("a refused save removes its optimistic patch without confirming it", async (t) => {
  const page = await mount(t);
  let confirmations = 0;
  await act(async () => { page.shown().change({ patch: { private: true }, onSaved: () => { confirmations += 1; } }); });
  await act(async () => { page.requests[0]!.answer(Response.json({ error: { code: "unauthorized" } }, { status: 401 })); });
  assert.deepEqual(page.shown().shown, SETTINGS);
  assert.deepEqual(page.saved, []);
  assert.equal(confirmations, 0);
  assert.equal(page.failed.length, 1);
  assert.equal(page.shown().saving, false);
});

test("a token resolving after an account switch cannot dispatch the earlier account's patch", async (t) => {
  let finishToken!: (token: string | null) => void;
  const token = new Promise<string | null>((resolve) => { finishToken = resolve; });
  const page = await mount(t, () => token);
  await act(async () => { page.shown().change({ patch: { private: true } }); });
  assert.deepEqual(page.requests, []);
  await page.render("b", async () => "token-b");
  await act(async () => { finishToken("token-b"); });
  assert.deepEqual(page.requests, [], "an old patch cannot dispatch with the new account's credentials");
  assert.deepEqual(page.saved, []);
  assert.equal(page.shown().saving, false);
});

test("switching back to the same account cannot resurrect a cancelled save waiting for a token", async (t) => {
  let finishToken!: (token: string | null) => void;
  const token = new Promise<string | null>((resolve) => { finishToken = resolve; });
  const page = await mount(t, () => token);
  await act(async () => { page.shown().change({ patch: { private: true } }); });
  await page.render("b", async () => "token-b");
  await page.render("a", async () => "token-a");
  await act(async () => { finishToken("token-a"); });
  assert.deepEqual(page.requests, []);
  assert.deepEqual(page.saved, []);
  assert.deepEqual(page.shown().shown, SETTINGS);
});

test("a token resolving after unmount cannot dispatch a queued patch", async (t) => {
  let finishToken!: (token: string | null) => void;
  const token = new Promise<string | null>((resolve) => { finishToken = resolve; });
  const page = await mount(t, () => token);
  await act(async () => { page.shown().change({ patch: { private: true } }); });
  await page.unmount();
  await act(async () => { finishToken(null); });
  assert.deepEqual(page.requests, [], "a wallet cookie is not sent after its owner left");
  assert.deepEqual(page.saved, []);
});

test("returning to an account ignores the response of its previously cancelled in-flight request", async (t) => {
  const page = await mount(t);
  await act(async () => { page.shown().change({ patch: { private: true } }); });
  await page.render("b", async () => "token-b");
  await page.render("a", async () => "token-a");
  await act(async () => { page.requests[0]!.answer(Response.json({ ...SETTINGS, privacy: "private" })); });
  assert.deepEqual(page.saved, []);
  assert.deepEqual(page.shown().shown, SETTINGS);
});

test("a valid wallet session saves through its same-origin cookie when the token source returns null", async (t) => {
  const page = await mount(t, async () => null);
  await act(async () => { page.shown().change({ patch: { private: true } }); });
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0]!.init?.credentials, "same-origin");
  assert.equal(new Headers(page.requests[0]!.init?.headers).has("authorization"), false);
  await act(async () => { page.requests[0]!.answer(Response.json({ ...SETTINGS, privacy: "private" })); });
  assert.deepEqual(page.saved, [{ accountId: "a", settings: { ...SETTINGS, privacy: "private" } }]);
  assert.equal(page.shown().saving, false);
});
