import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { SocialMeAccount } from "@blast/core/modules/social/contracts/me.ts";
import type { SocialNotification } from "@blast/core/modules/social/contracts/notifications.ts";
import type { AccessTokenSource } from "../social-fetch.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { ToastProvider } = await import("#web/components/blast-ui/Toasts.tsx");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { SocialViewerProvider } = await import("../SignInGate.tsx");
const { SocialAccountContext } = await import("../use-social-account.ts");
const { NotificationsScreen } = await import("./NotificationsScreen.tsx");
const { UnreadNotificationsProvider, useUnreadNotificationsState } = await import("./use-unread-notifications.tsx");

function account(accountId: string): SocialMeAccount {
  return {
    account_id: accountId, kind: "new", callsign: accountId, display_name: null, avatar_url: null, x_handle: null,
    verified: false, onboarding: { shown: true, completed: true }, privacy: "private", sharing_since_ms: null,
    wallets: [],
  };
}

function notification(accountId: string): SocialNotification {
  return {
    id: String(["a", "b", "old-a", "older-b"].indexOf(accountId) + 1), kind: "claim", title: `${accountId} claim is ready`, sub: "Ready to claim", occurred_at_ms: 1,
    read: false, href: `/presale/${accountId}`, presale: null, actor: null,
  };
}

function Session({ accountId, getAccessToken, showPage }: Readonly<{ accountId: string | null; getAccessToken: AccessTokenSource; showPage: boolean }>) {
  const unread = useUnreadNotificationsState({ accountId, getAccessToken });
  return <UnreadNotificationsProvider value={unread}>{showPage ? <NotificationsScreen /> : <p>Another page</p>}</UnreadNotificationsProvider>;
}

type Request = { path: string; init: RequestInit | undefined; answer(response: Response): void };

async function mount(t: TestContext, empty = false, initialItem = notification) {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  let holdFirstPage = false;
  let firstPage: ((accountId: string) => unknown) | null = null;
  let unreadCount: number | null = null;
  globalThis.fetch = (input, init) => {
    const path = String(input);
    const accountId = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "visitor";
    if (init?.method === "POST" || path.includes("?cursor=")) {
      return new Promise<Response>((answer) => { requests.push({ path, init, answer }); });
    }
    if (path === "/api/social/me/presales") {
      return Promise.resolve(Response.json({ created: [], positions: [], watchlist: [], coins: [], vestings: [] }));
    }
    if (path.endsWith("/unread")) return Promise.resolve(Response.json({ unread_count: unreadCount ?? (accountId === "a" ? 3 : 7) }));
    assert.equal(path, "/api/social/me/notifications");
    if (holdFirstPage) return new Promise<Response>((answer) => { requests.push({ path, init, answer }); });
    if (firstPage) return Promise.resolve(Response.json(firstPage(accountId)));
    return Promise.resolve(Response.json({ items: empty ? [] : [initialItem(accountId)], unread_count: empty ? 0 : accountId === "a" ? 3 : 7, next_cursor: empty ? null : "older" }));
  };
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  const unreadWrites: number[] = [];
  client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryKey.at(-1) !== "unread") return;
    const data = client.getQueryData<{ unread_count: number }>(queryKeys.me.notifications.unread());
    if (data) unreadWrites.push(data.unread_count);
  });
  const container = document.createElement("div");
  container.addEventListener("click", (event) => event.preventDefault(), true);
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  let currentAccountId: string | null = "a";
  let currentTokenSource: AccessTokenSource = async () => "a";
  const render = async (accountId: string | null, getAccessToken: AccessTokenSource = async () => accountId, showPage = true, settle = true) => {
    currentAccountId = accountId;
    currentTokenSource = getAccessToken;
    await act(async () => {
      root.render(withQueryClient(client,
        <StrictMode>
          <PathnameContext value="/notifications">
            <SocialViewerProvider callsign={accountId} getAccessToken={getAccessToken} signedIn={accountId !== null}>
              <SocialAccountContext value={accountId === null
                ? { status: "signed_out", account: null, refresh: () => undefined }
                : { status: "ready", account: account(accountId), refresh: () => undefined }}>
                <ToastProvider><Session accountId={accountId} getAccessToken={getAccessToken} showPage={showPage} /></ToastProvider>
              </SocialAccountContext>
            </SocialViewerProvider>
          </PathnameContext>
        </StrictMode>,
      ));
    });
    if (settle) await act(async () => { await settleQueries(client); });
  };
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => { root.unmount(); });
  };
  t.after(async () => {
    await unmount();
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await render("a");
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
    assert.ok(found, `${label} is available`);
    return found;
  };
  return {
    client, requests, unreadWrites, container, render, unmount, button,
    holdRefresh: () => { holdFirstPage = true; },
    serveFirstPage: (body: (accountId: string) => unknown) => { firstPage = body; },
    /** The server took the seen write: later reads answer no unread rows. */
    serveAllRead: () => {
      unreadCount = 0;
      firstPage = (accountId) => ({ items: [{ ...notification(accountId), read: true }], unread_count: 0, next_cursor: null });
    },
    /** What the arrivals poll or a focus refresh writes when it reads a count. */
    countRead: (count: number) => act(async () => {
      client.setQueryData(queryKeys.me.notifications.unread(), { unread_count: count });
      await settleQueries(client);
    }),
    navigate: () => render(currentAccountId, currentTokenSource, false),
    unread: () => client.getQueryData<{ unread_count: number }>(queryKeys.me.notifications.unread())?.unread_count,
  };
}

const READ_ALL = "/api/social/me/notifications/read";
const seenWrites = (requests: readonly Request[]) => requests.filter((request) => request.path === READ_ALL);

test("opening the page marks notifications seen through the last fetched ID", async (t) => {
  const page = await mount(t);
  assert.deepEqual(page.requests.map((request) => request.path), [READ_ALL]);
  assert.equal(page.requests[0]!.init?.method, "POST");
  assert.equal(page.requests[0]!.init?.body, '{"through":"1"}');
  assert.equal(page.unread(), 0, "the badge clears as the page shows");
  assert.equal(page.container.querySelector("[data-unread]"), null);
  assert.equal([...page.container.querySelectorAll("button")].some((button) => button.textContent === "Mark all read"), false);
  await act(async () => { page.requests[0]!.answer(Response.json({ unread_count: 0 })); });
  assert.equal(page.unread(), 0);
});

test("one vesting link tracks eligible schedules when the inbox is empty or read", async (t) => {
  const page = await mount(t, true);
  const links = () => [...page.container.querySelectorAll('a[href="/portfolio?tab=vestings"]')].map((link) => link.textContent);
  const holdings = { created: [], positions: [], watchlist: [], coins: [] };
  const setClaimable = (amounts: readonly string[]) => act(async () => {
    page.client.setQueryData(queryKeys.me.presales(), { ...holdings, vestings: amounts.map((claimable) => ({ claimable })) });
    await settleQueries(page.client);
  });
  assert.equal(page.unread(), 0);
  assert.deepEqual(links(), []);
  assert.match(page.container.textContent ?? "", /No notifications yet/);

  await setClaimable(["0", "0.000000001"]);
  assert.deepEqual(links(), ["1 vesting claim ready"]);
  assert.doesNotMatch(page.container.textContent ?? "", /No notifications yet/);
  assert.equal(seenWrites(page.requests).length, 0);

  page.serveFirstPage((owner) => ({ items: [notification(owner)], unread_count: 1, next_cursor: null }));
  await page.countRead(1);
  await act(async () => { page.requests[0]!.answer(Response.json({ unread_count: 0 })); });
  assert.ok(page.container.querySelector('a[href="/presale/a"]'));
  assert.equal(page.unread(), 0);
  assert.deepEqual(links(), ["1 vesting claim ready"]);

  await setClaimable(["0.000000001", "100"]);
  assert.deepEqual(links(), ["2 vesting claims ready"]);

  await setClaimable(["0"]);
  assert.deepEqual(links(), []);

  await page.render(null);
  await setClaimable(["100"]);
  assert.match(page.container.textContent ?? "", /Sign in to see your notifications/);
  assert.deepEqual(links(), []);
});

test("a failed seen write shows the unread rows again and does not retry in a loop", async (t) => {
  const page = await mount(t);
  await act(async () => { page.requests[0]!.answer(Response.json({ error: { code: "unavailable" } }, { status: 503 })); });
  await act(async () => { await settleQueries(page.client); });
  assert.equal(page.unread(), 3);
  assert.ok(page.container.querySelector("[data-unread]"));
  assert.equal(seenWrites(page.requests).length, 1);
});

test("a count read before the seen write landed cannot put the badge back", async (t) => {
  const page = await mount(t);
  await page.countRead(3);
  assert.equal(page.container.querySelector("[data-unread]"), null, "the page is not read again while the write is in flight");
  page.serveAllRead();
  await act(async () => { page.requests[0]!.answer(Response.json({ unread_count: 0 })); });
  await act(async () => { await settleQueries(page.client); });
  assert.equal(page.unread(), 0);
  assert.equal(page.container.querySelector("[data-unread]"), null);
  assert.equal(seenWrites(page.requests).length, 1);
});

test("notifications arriving during a seen write are fetched before being marked seen", async (t) => {
  const page = await mount(t);
  page.serveFirstPage((accountId) => ({
    items: [
      { ...notification(accountId), id: "9007199254740992", title: "new claim", occurred_at_ms: 3 },
      { ...notification(accountId), id: "9007199254740993", occurred_at_ms: 2 },
      { ...notification(accountId), read: true },
    ],
    unread_count: 2,
    next_cursor: null,
  }));
  await act(async () => {
    page.requests[0]!.answer(Response.json({ unread_count: 2 }));
    await settleQueries(page.client);
  });
  assert.match(page.container.textContent!, /new claim/);
  assert.equal(seenWrites(page.requests).length, 2);
  assert.equal(seenWrites(page.requests)[1]!.init?.body, '{"through":"9007199254740993"}');
  assert.equal(page.unread(), 0);
  assert.equal(page.container.querySelector("[data-unread]"), null);
});

test("a backdated arrival is marked seen when its older page is shown", async (t) => {
  const page = await mount(t);
  page.serveFirstPage((accountId) => ({
    items: [{ ...notification(accountId), read: true }], unread_count: 1, next_cursor: "older",
  }));
  await act(async () => {
    seenWrites(page.requests)[0]!.answer(Response.json({ unread_count: 1 }));
    await settleQueries(page.client);
  });
  assert.equal(page.unread(), 1);
  assert.equal(seenWrites(page.requests).length, 1);

  await act(async () => { page.button("Show older").click(); });
  await act(async () => {
    page.requests.find((request) => request.path.includes("?cursor="))!.answer(Response.json({
      items: [{ ...notification("old-a"), occurred_at_ms: 0 }], unread_count: 1, next_cursor: null,
    }));
  });
  assert.deepEqual(seenWrites(page.requests).map((request) => request.init?.body), ['{"through":"1"}', '{"through":"3"}']);
  await act(async () => { seenWrites(page.requests)[1]!.answer(Response.json({ unread_count: 0 })); });
  assert.equal(page.unread(), 0);
  assert.ok(page.container.querySelector('[data-row-id="3"]'));
  assert.equal(page.container.querySelector('[data-row-id="3"][data-unread]'), null);
});

test("older responses respect a seen write whether they arrive before or after it", async (t) => {
  const page = await mount(t, false, (accountId) => ({ ...notification(accountId), id: "4" }));
  await act(async () => { page.button("Show older").click(); });
  await act(async () => {
    page.requests[1]!.answer(Response.json({
      items: [notification("old-a")], unread_count: 3, next_cursor: "oldest",
    }));
  });
  await act(async () => { page.button("Show older").click(); });
  await act(async () => { seenWrites(page.requests)[0]!.answer(Response.json({ unread_count: 0 })); });
  assert.ok(page.container.querySelector('[data-row-id="3"]'));
  assert.ok(!page.container.querySelector('[data-row-id="3"][data-unread]'), "the row fetched before the write is read");

  await act(async () => {
    page.requests[2]!.answer(Response.json({
      items: [{ ...notification("a"), id: "2" }], unread_count: 3, next_cursor: null,
    }));
  });
  assert.ok(page.container.querySelector('[data-row-id="2"]'));
  assert.ok(!page.container.querySelector('[data-row-id="2"][data-unread]'), "the late row is also read");
  assert.equal(seenWrites(page.requests).length, 1);
  assert.equal(page.unread(), 0);
});

test("acknowledging an older page keeps it open when deeper alerts are unread", async (t) => {
  const page = await mount(t);
  let unread = 2;
  page.serveFirstPage((accountId) => ({
    items: [{ ...notification(accountId), read: true }], unread_count: unread, next_cursor: "older",
  }));
  await act(async () => {
    seenWrites(page.requests)[0]!.answer(Response.json({ unread_count: 2 }));
    await settleQueries(page.client);
  });
  await act(async () => { page.button("Show older").click(); });
  await act(async () => {
    page.requests.find((request) => request.path.endsWith("?cursor=older"))!.answer(Response.json({
      items: [notification("old-a")], unread_count: 2, next_cursor: "oldest",
    }));
  });
  assert.equal(seenWrites(page.requests)[1]!.init?.body, '{"through":"3"}');
  await act(async () => {
    unread = 1;
    seenWrites(page.requests)[1]!.answer(Response.json({ unread_count: 1 }));
    await settleQueries(page.client);
  });
  assert.equal(page.unread(), 1);
  assert.ok(page.container.querySelector('[data-row-id="3"]'));
  await act(async () => { page.button("Show older").click(); });
  assert.ok(page.requests.some((request) => request.path.endsWith("?cursor=oldest")));
});

test("an older alert stays unread when its seen write fails", async (t) => {
  const page = await mount(t);
  page.serveFirstPage((accountId) => ({
    items: [{ ...notification(accountId), read: true }], unread_count: 1, next_cursor: "older",
  }));
  await act(async () => {
    seenWrites(page.requests)[0]!.answer(Response.json({ unread_count: 1 }));
    await settleQueries(page.client);
  });
  await act(async () => { page.button("Show older").click(); });
  await act(async () => {
    page.requests.find((request) => request.path.endsWith("?cursor=older"))!.answer(Response.json({
      items: [notification("old-a")], unread_count: 1, next_cursor: null,
    }));
  });
  assert.equal(seenWrites(page.requests)[1]!.init?.body, '{"through":"3"}');
  await act(async () => {
    seenWrites(page.requests)[1]!.answer(Response.json({ error: { code: "unavailable" } }, { status: 503 }));
    await settleQueries(page.client);
  });
  assert.equal(page.unread(), 1);
  assert.ok(page.container.querySelector('[data-row-id="3"][data-unread]'));
  assert.equal(seenWrites(page.requests).length, 2);
});

test("a page opened in a background tab is marked seen only when the tab is shown", async (t) => {
  let state: DocumentVisibilityState = "hidden";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  t.after(() => { delete (document as { visibilityState?: unknown }).visibilityState; });
  const page = await mount(t);
  assert.equal(seenWrites(page.requests).length, 0);
  assert.ok(page.container.querySelector("[data-unread]"));
  state = "visible";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await settleQueries(page.client); });
  assert.equal(seenWrites(page.requests).length, 1);
  assert.equal(page.unread(), 0);
});

test("a seen answer from the previous account cannot write the new account's unread cache", async (t) => {
  const page = await mount(t);
  await page.render("b");
  assert.equal(seenWrites(page.requests).length, 2, "each account's page marks its own rows seen");
  const writesBefore = page.unreadWrites.length;
  await act(async () => { page.requests[0]!.answer(Response.json({ unread_count: 99 })); });
  assert.ok(!page.unreadWrites.slice(writesBefore).includes(99), "the previous account's answer never enters the shared cache");
  assert.equal(page.unread(), 0);
  assert.match(page.container.textContent!, /b claim is ready/);
});

test("a revisit keeps a known empty notifications page through refresh and refresh failure", async (t) => {
  const page = await mount(t, true);
  assert.match(page.container.textContent!, /No notifications yet/);
  await page.navigate();
  page.holdRefresh();
  await page.render("a", undefined, true, false);
  assert.match(page.container.textContent!, /No notifications yet/);
  assert.equal(page.container.querySelector('[aria-label="Loading notifications"]'), null);
  await act(async () => {
    page.requests[0]!.answer(Response.json({ error: { code: "unavailable" } }, { status: 503 }));
  });
  for (let attempt = 0; attempt < 50 && !page.container.textContent?.includes("Notifications couldn’t refresh"); attempt++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  assert.match(page.container.textContent!, /No notifications yet/);
  assert.match(page.container.textContent!, /Code: unavailable/);
});

test("a late seen answer after unmount cannot write the shared unread cache", async (t) => {
  const page = await mount(t);
  await page.unmount();
  await act(async () => { page.requests[0]!.answer(Response.json({ unread_count: 99 })); });
  assert.equal(page.unread(), 0);
});

test("a previous account's older-page answer cannot clear a new account's pending read", async (t) => {
  const page = await mount(t);
  await act(async () => { page.button("Show older").click(); });
  await page.render("b");
  assert.equal(page.button("Show older").disabled, false);
  await act(async () => { page.button("Show older").click(); });
  await act(async () => { page.requests.filter((request) => request.path.includes("?cursor="))[0]!.answer(Response.json({ items: [notification("old-a")], next_cursor: null, unread_count: 3 })); });
  assert.equal(page.container.querySelector<HTMLButtonElement>('button[aria-busy="true"]')?.getAttribute("aria-disabled"), "true");
  assert.doesNotMatch(page.container.textContent!, /old-a claim is ready/);
  await act(async () => { page.requests.filter((request) => request.path.includes("?cursor="))[1]!.answer(Response.json({ items: [notification("older-b")], next_cursor: null, unread_count: 7 })); });
  assert.match(page.container.textContent!, /older-b claim is ready/);
});

test("the seen write finishes when navigation removes only the page", async (t) => {
  const page = await mount(t);
  await page.navigate();
  assert.equal(page.container.querySelector("p")?.textContent, "Another page");
  await act(async () => { page.requests[0]!.answer(Response.json({ unread_count: 2 })); });
  assert.equal(page.unread(), 2, "the shell still owns the same-account write");
});
