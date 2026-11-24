import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { SocialNotification } from "@blast/core/modules/social/contracts/notifications.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NotificationsView } = await import("./NotificationsView.tsx");

function notification(id: string, sub: string, kind: SocialNotification["kind"] = "funded"): SocialNotification {
  return {
    id, kind, title: "alon is funded", sub, occurred_at_ms: 1, read: false,
    href: "/presale/alon", presale: null, actor: null,
  };
}

async function mount(t: TestContext, items: readonly SocialNotification[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(<NotificationsView items={items} mode="list" nowMs={2} />);
  });
  return container;
}

test("funded notification logos preserve the trading context, accessible venue name, destination and unread state", async (t) => {
  const page = await mount(t, [
    notification("1", "1.01× oversubscribed · trading opens on Bluefin"),
    notification("2", "Trading opens on Bluefin"),
  ]);
  const rows = [...page.querySelectorAll<HTMLAnchorElement>("a[data-unread]")];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const logo = row.querySelector<HTMLImageElement>('img[alt="Bluefin"]');
    assert.ok(logo);
    assert.equal(logo.getAttribute("src"), "/blast-ui/dex/bluefin.svg");
    assert.equal(logo.parentElement?.title, "Bluefin");
    assert.equal(row.getAttribute("href"), "/presale/alon");
    assert.match(row.textContent!, /Unread:/);
  }
  assert.match(rows[0]!.textContent!, /1\.01× oversubscribed · trading opens on /);
  assert.match(rows[1]!.textContent!, /Trading opens on /);
});

test("other kinds, unknown venues and other Bluefin references retain their original copy", async (t) => {
  const subtitles = ["Trading opens on Cetus", "Trading opens soon", "Learn about Bluefin", "Bluefin"];
  const page = await mount(t, subtitles.map((sub, index) => notification(String(index + 1), sub, index === 3 ? "follow" : "funded")));
  assert.equal(page.querySelector('img[alt="Bluefin"]'), null);
  for (const sub of subtitles) assert.ok(page.textContent?.includes(sub));
});

test("an unavailable Bluefin logo restores the complete original subtitle", async (t) => {
  const sub = "1.01× oversubscribed · trading opens on Bluefin";
  const page = await mount(t, [notification("1", sub)]);
  const logo = page.querySelector('img[alt="Bluefin"]');
  assert.ok(logo);
  await act(async () => { logo.dispatchEvent(new window.Event("error")); });
  assert.equal(page.querySelector('img[alt="Bluefin"]'), null);
  assert.ok(page.textContent?.includes(sub));
  assert.ok(page.querySelector('a[data-unread][href="/presale/alon"]'));
});

test("rows group under Today and Earlier by the viewer's calendar day, and an empty group is left out", async (t) => {
  const nowMs = new Date(2026, 9, 27, 15).getTime();
  const at = (id: string, occurred_at_ms: number) => ({ ...notification(id, "Trading opens soon"), occurred_at_ms });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<NotificationsView items={[at("1", nowMs - 3_600_000), at("2", nowMs - 2 * 86_400_000)]} mode="list" nowMs={nowMs} />));
  const groups = [...container.querySelectorAll("section")].map((section) => [section.querySelector("h2")!.textContent, section.querySelectorAll("a").length]);
  assert.deepEqual(groups, [["Today", 1], ["Earlier", 1]]);
  await act(async () => root.render(<NotificationsView items={[at("1", nowMs - 3_600_000)]} mode="list" nowMs={nowMs} />));
  assert.deepEqual([...container.querySelectorAll("h2")].map((heading) => heading.textContent), ["Today"]);
});

test("nothing yet and a failed read use the shared empty state; the failure offers a retry", async (t) => {
  let retried = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<NotificationsView items={[]} mode="empty" nowMs={0} />));
  assert.match(container.textContent!, /No notifications yet/);
  await act(async () => root.render(<NotificationsView items={[]} mode="error" nowMs={0} onRetry={() => { retried++; }} />));
  const alert = container.querySelector('[role="alert"]')!;
  assert.match(alert.textContent!, /couldn’t load/);
  await act(async () => alert.querySelector("button")!.click());
  assert.equal(retried, 1);
});

test("Notifications board: each kind's status badge, the unread wash, and no Mark all read", async (t) => {
  const kinds: readonly [SocialNotification["kind"], string][] = [["claim", "Claims are open for Halcyon"], ["fill", "Meridian is 80% filled"], ["funded", "Lumen is funded"], ["soon", "Last hour for Tidal"], ["soon", "Ferro opens tomorrow"], ["follow", "kenji backed Ferro"], ["unlock", "Halcyon unlocks soon"], ["call_up", "WAL is up 100% since your call"]];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const items = kinds.map(([kind, title], index) => ({ ...notification(String(index + 1), "Sub", kind), title, read: index > 1 }));
  await act(async () => root.render(<NotificationsView items={items} mode="list" nowMs={2} />));
  const rows = [...container.querySelectorAll<HTMLAnchorElement>("a")];
  assert.deepEqual(rows.map((row) => row.querySelector("em")!.getAttribute("data-tone")), ["ink", "pink", "info", "pink", "warn", "ink", "warn", "up"]);
  assert.deepEqual(rows.map((row) => row.hasAttribute("data-unread")), [true, true, false, false, false, false, false, false]);
  assert.equal(container.querySelector("button"), null, "opening the page marks it seen; there is no Mark all read");
  assert.equal(container.firstElementChild?.getAttribute("data-shell-aside"), "medium");
});
