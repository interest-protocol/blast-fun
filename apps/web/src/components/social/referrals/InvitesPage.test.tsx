import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient, settleQueries } = await import("#web/lib/query/test-client.ts");
const { SocialViewerProvider } = await import("../SignInGate");
const { InviteesView, InvitesPage } = await import("./InvitesPage");
const { ReferralAccounting } = await import("./ReferralAccounting");
const cursor = "00000000-0000-4000-8000-000000000001";
const person = { id: cursor, callsign: "nova", display_name: "Nova", avatar_url: "https://pbs.twimg.com/profile_images/nova_normal.jpg", x_handle: "nova_x" };

test("referral amounts hide unavailable figures and copy readable amounts with the full coin type", async (t) => {
  const coinType = `0x${"a".repeat(64)}::usd::USD`;
  const usd = { coin_type: coinType, symbol: "USD", decimals: 6, volume_atoms: "1234567", revenue_atoms: "123", earnings_atoms: "47" };
  const other = { ...usd, coin_type: `0x${"b".repeat(64)}::usd::USD`, symbol: "usd" };
  const missing = { ...usd, coin_type: `0x${"c".repeat(64)}::other::OTHER`, symbol: "OTHER", decimals: null, volume_atoms: "999999999" };
  const copied: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { copied.push(value); } },
  });
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
  const accounting = { assets: [usd, other, missing], as_of_ms: 1, share_bps: 6000 as const, pending_events: 0 };
  await act(async () => root.render(<ReferralAccounting accounting={accounting} compact />));
  const first = container.querySelector<HTMLButtonElement>('button[aria-label="Inspect 1.234567 USD. 0xaaaa…aaaa::usd::USD"]')!;
  assert.ok(first);
  assert.ok(container.querySelector('button[aria-label="Inspect 1.234567 usd. 0xbbbb…bbbb::usd::USD"]'));
  await act(async () => first.click());
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.doesNotMatch(dialog.textContent!, new RegExp(coinType));
  const copy = dialog.querySelector<HTMLButtonElement>('button[aria-label="Copy full amount"]')!;
  await act(async () => copy.click());
  assert.deepEqual(copied, [`1.234567 USD\n${coinType}`]);
  const unavailable = [...container.querySelectorAll("dd")].filter((cell) => cell.textContent === "Amount unavailable");
  assert.equal(unavailable.length, 3);
  assert.ok(unavailable.every((cell) => cell.querySelector("button") === null));
  assert.doesNotMatch(container.innerHTML, /999999999| atoms/);
  for (const button of container.querySelectorAll("button[aria-label]")) {
    assert.ok(button.getAttribute("aria-label")!.split(/\s+/).length <= 6);
  }
});

test("session pending retains the invite list heading and section spacing without private rows", async (t) => {
  const client = createTestQueryClient();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider signedIn={false} sessionPending><InvitesPage /></SocialViewerProvider></QueryProvider>));
  const heading = container.querySelector("#invitees-heading")!;
  assert.equal(heading.textContent, "People you invited");
  assert.ok(heading.closest(".sec"));
  assert.equal(container.querySelectorAll("li").length, 0);
  assert.doesNotMatch(container.textContent!, /Sign in/);
});

test("Invites page shows a private total, profile links and paged invitees, then clears on sign-out", async (t) => {
  const reads: string[] = [];
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request) => {
    const url = String(path); reads.push(url);
    return Response.json(url.includes("/invitees") ? url.includes("cursor=")
      ? { invitees: [{ ...person, id: cursor.replace(/1$/, "2"), callsign: null, display_name: "Legacy member" }], next_cursor: null }
      : { invitees: [person], next_cursor: cursor }
      : { invited: 2, volume_usd: "10000.00", unvalued_trades: 0 });
  });
  const client = createTestQueryClient();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const render = (signedIn: boolean) => <QueryProvider client={client}><SocialViewerProvider signedIn={signedIn} callsign={signedIn ? "kai_9" : null}><InvitesPage /></SocialViewerProvider></QueryProvider>;
  await act(async () => root.render(render(true)));
  await act(async () => settleQueries(client));
  assert.equal(container.querySelector("h1")!.textContent, "Invites");
  assert.equal(container.querySelector('[data-back-bar] a')!.textContent, "Profile");
  assert.equal(container.querySelector('[data-back-bar] a')!.getAttribute("href"), "/@kai_9");
  assert.equal(container.querySelector("#invitees-heading")!.tagName, "H2");
  assert.equal(container.querySelector(".inviteVolume strong")!.textContent, "$10,000.00");
  assert.ok(container.querySelector('a[href="/@nova"]'));
  assert.ok(container.querySelector('a[href="https://x.com/nova_x"]'));
  assert.equal(container.querySelectorAll("li").length, 1);
  await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Load more")!.click(); await settleQueries(client); });
  assert.equal(container.querySelectorAll("li").length, 2);
  assert.match(container.textContent!, /Legacy member/);
  assert.ok(container.querySelectorAll("li")[1].querySelector('img[src*="nova"]'), "launch-code invitees keep their saved avatar");
  assert.equal(container.querySelectorAll('a[href="https://x.com/nova_x"]').length, 2);
  assert.equal(container.querySelectorAll("a a").length, 0, "X links are separate from Blast profile links");
  // The Invites board's row is the face, the name and the X handle: no bare "Source" label, and no joined line without the date.
  assert.doesNotMatch(container.textContent!, /Source|Joined/);
  assert.equal(container.querySelectorAll("li")[0]!.querySelector("b")!.textContent, "Nova");
  assert.ok(reads.some((url) => url.endsWith(`?cursor=${cursor}`)));
  await act(async () => root.render(render(false)));
  assert.equal(container.querySelectorAll("li").length, 0);
  assert.doesNotMatch(container.textContent!, /\$10,000/);
  assert.match(container.textContent!, /Sign in to see your invites/);
});

test("invitees without X or an avatar retain the generated avatar and Blast profile link", async (t) => {
  const client = createTestQueryClient();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><InviteesView
    invitees={[{ ...person, avatar_url: null, x_handle: null }]} pending={false} failed={false}
    hasMore={false} loadingMore={false} onMore={() => {}} onRetry={() => {}}
  /></QueryProvider>));
  assert.ok(container.querySelector('a[href="/@nova"]'));
  assert.ok(container.querySelector('[data-avatar="generated"]'));
  assert.equal(container.querySelectorAll('a[href^="https://x.com/"]').length, 0);
});

test("each invitee reads \"Joined 24 Oct ’26\" under the name, a member without a profile too", async (t) => {
  const client = createTestQueryClient();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  // Midday UTC, so the reader's zone keeps the same day.
  const joined = Date.UTC(2026, 9, 24, 12);
  await act(async () => root.render(<QueryProvider client={client}><InviteesView
    invitees={[{ ...person, joined_at_ms: joined }, { ...person, id: cursor.replace(/1$/, "2"), callsign: null, display_name: "Legacy member", joined_at_ms: Date.UTC(2025, 2, 3, 12) }, { ...person, id: cursor.replace(/1$/, "3"), callsign: "kai" }]}
    pending={false} failed={false} hasMore={false} loadingMore={false} onMore={() => {}} onRetry={() => {}}
  /></QueryProvider>));
  const identities = [...container.querySelectorAll("li")].map((row) => [...row.querySelector("b")!.parentElement!.children].map((part) => part.textContent));
  assert.deepEqual(identities, [["Nova", "Joined 24 Oct ’26"], ["Legacy member", "Joined 3 Mar ’25"], ["Nova"]]);
});

test("failed invitee reads can be retried and an empty list keeps the invite action", async (t) => {
  let failed = true;
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request) => String(path).includes("/invitees")
    ? failed ? Response.json({ error: { code: "service_unavailable" } }, { status: 503 }) : Response.json({ invitees: [], next_cursor: null })
    : Response.json({ invited: 0, volume_usd: "0.00", unvalued_trades: 0 }));
  const client = createTestQueryClient();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider signedIn callsign="kai_9"><InvitesPage /></SocialViewerProvider></QueryProvider>));
  await act(async () => settleQueries(client));
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /Invites couldn’t load/);
  failed = false;
  await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry invites")!.click(); await settleQueries(client); });
  assert.match(container.textContent!, /No invitees yet/);
  assert.ok(container.querySelector('[aria-label="Copy your invite link"]'));
});
