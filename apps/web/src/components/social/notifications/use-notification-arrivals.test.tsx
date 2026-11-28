import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
const { document, window } = installTestDom();
const { act, useEffect, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { useNotificationArrivals } = await import("./use-notification-arrivals.ts");

test("the foreground reader silently baselines, deduplicates, consumes returns and cancels ownership", async (t) => {
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let ids = ["1"];
  let pulses = 0;
  let count = 1;
  let mounted = true;
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input instanceof Request ? input.url : input));
    const newest = ids.reduce<string | null>((max, id) => max === null || BigInt(id) > BigInt(max) ? id : max, null);
    return Response.json({ unread_count: ids.length, newest_unread_id: newest });
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  const token = async () => "token";
  const setCount = (value: number) => { count = value; };
  function Session() {
    const subscribe = useNotificationArrivals("account", token, setCount);
    useEffect(() => subscribe(() => { pulses++; }), [subscribe]);
    return <span>Session</span>;
  }
  const render = async (show = true) => { await act(async () => { root.render(withQueryClient(client, show ? <StrictMode><Session /></StrictMode> : null)); await settleQueries(client); }); };
  const refresh = async () => { await act(async () => { await client.refetchQueries({ queryKey: queryKeys.me.notifications.arrivals() }); }); };
  t.after(async () => { if (mounted) await act(async () => root.unmount()); container.remove(); client.clear(); });
  await render();
  assert.equal(pulses, 0);
  ids = ["2", "3", "1"];
  await refresh();
  assert.equal(pulses, 1);
  assert.equal(count, 3);
  await refresh();
  assert.equal(pulses, 1);
  ids = [];
  await refresh();
  assert.equal(count, 0);
  assert.equal(pulses, 1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new window.Event("visibilitychange"));
  ids = ["4"];
  await refresh();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.dispatchEvent(new window.Event("visibilitychange"));
  await refresh();
  assert.equal(pulses, 1);
  await render(false);
  ids = ["5", "4"];
  await render();
  await refresh();
  assert.equal(pulses, 1);
  ids = ["6", "5", "4"];
  await refresh();
  assert.equal(pulses, 2);
  ids = ["7", "5", "4"];
  await refresh();
  assert.equal(count, 3);
  assert.equal(pulses, 3, "one alert read and another arrived: the count stays, the alert still pops");
  assert.ok(urls.length > 0 && urls.every((url) => url.endsWith("/api/social/me/notifications/unread?newest=1")), "the poll never reads the list");
  await act(async () => root.unmount());
  mounted = false;
});

test("an older backend's count-only answer keeps the count and never pops; its first ID is the starting point", async (t) => {
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let answer: object = { unread_count: 2 };
  let count = 0;
  let pulses = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json(answer));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  const token = async () => "token";
  function Session() {
    const subscribe = useNotificationArrivals("account", token, (value) => { count = value; });
    useEffect(() => subscribe(() => { pulses++; }), [subscribe]);
    return null;
  }
  const refresh = async () => { await act(async () => { await client.refetchQueries({ queryKey: queryKeys.me.notifications.arrivals() }); }); };
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => { root.render(withQueryClient(client, <Session />)); await settleQueries(client); });
  assert.equal(count, 2);
  answer = { unread_count: 3 };
  await refresh();
  assert.equal(count, 3);
  answer = { unread_count: 3, newest_unread_id: "9" };
  await refresh();
  assert.equal(pulses, 0, "the first ID after the deploy is the starting point");
  answer = { unread_count: 4, newest_unread_id: "10" };
  await refresh();
  assert.equal(pulses, 1);
});

test("a slow snapshot cannot restore unread notifications cleared while it was in flight", async (t) => {
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const snapshot = { unread_count: 4, newest_unread_id: null };
  let answer: ((response: Response) => void) | undefined;
  let hold = false;
  let count = 4;
  t.mock.method(globalThis, "fetch", () => hold ? new Promise<Response>((resolve) => { answer = resolve; }) : Promise.resolve(Response.json(snapshot)));
  const token = async () => "token";
  const setCount = (value: number) => { count = value; client.setQueryData(queryKeys.me.notifications.unread(), { unread_count: value }); };
  function Session() { useNotificationArrivals("account", token, setCount); return null; }
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => { root.render(withQueryClient(client, <Session />)); await settleQueries(client); });
  setCount(0);
  hold = true;
  let pending: Promise<void>;
  await act(async () => {
    pending = client.refetchQueries({ queryKey: queryKeys.me.notifications.arrivals() });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(answer);
  setCount(0);
  await act(async () => { answer!(Response.json(snapshot)); await pending; });
  assert.equal(count, 0, "even a same-value zero write supersedes the older snapshot");
});
