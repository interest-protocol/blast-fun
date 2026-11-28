import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestDom, recordAnimations, testEvent, type TestElement } from "../../../test/fixtures/social/test-dom.ts";

/**
 * OA-31: the account and Create menus went invisible on their second
 * opening. The close animated with `fill: "forwards"` on a menu that stayed in
 * the page (`hidden`), so the held close outlived the next opening's own
 * animation and took the menu back to opacity 0 (seen in Chromium and
 * WebKit). The gate (version 5) cancels a menu's animations as it opens:
 * "a menu still closing is caught when reopened".
 *
 * OA-28 M2b moved both menus onto base-ui's `Menu` (`BlastMenu`): a closed
 * menu is unmounted once its exit ends, and one pressed again while it
 * leaves is caught (its exit cancelled, the same menu arriving again). The
 * shell renders in jsdom (`test-dom.ts`) with its animations
 * kept, so a test can run each motion to its end and read the opacity it
 * leaves on the menu.
 */

const { document } = installTestDom();
const motion = recordAnimations();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { RouterContext } = await import("next/dist/shared/lib/router-context.shared-runtime");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { AppShell } = await import("./AppShell");
const { ACCOUNT_MENU_ID } = await import("./AccountMenu");
const { useShellAction } = await import("./shell-actions");
const { CREATE_MENU_ID } = await import("./CreateMenu");
const { createMenuPlacement } = await import("./create-menu-model.ts");

const pushed: string[] = [];
const router = { push: (href: string) => void pushed.push(href), replace: () => undefined, refresh: () => undefined, back: () => undefined, forward: () => undefined, prefetch: () => undefined };
// Node uses Link's Pages entry; provide its context as in NavigationLink.test.tsx.
const linkRouter = {
  basePath: "", route: "/", pathname: "/", query: {}, asPath: "/", isFallback: false, isReady: true, isPreview: false, isLocaleDomain: false,
  push: async () => true, replace: async () => true, prefetch: async () => {},
  reload() {}, back() {}, forward() {}, beforePopState() {}, events: { on() {}, off() {}, emit() {} },
};
const KAI = { accountId: "a-kai", callsign: "kaimoreno", displayName: "Kai Moreno", avatarUrl: null, verified: true };

function ActionHost({ onDeposit, onFund, onNotifications }: Readonly<{ onDeposit: () => void; onFund: () => void; onNotifications: () => void }>) {
  useShellAction("openDeposit", onDeposit);
  useShellAction("openFund", onFund);
  useShellAction("openNotifications", onNotifications);
  return null;
}

async function mount(t: TestContext, { signedIn = true, viewerLoading = false, onSignOut, onDeposit = () => undefined, onFund = () => undefined, onNotifications = () => undefined }: Readonly<{ signedIn?: boolean; viewerLoading?: boolean; onSignOut?: () => Promise<void>; onDeposit?: () => void; onFund?: () => void; onNotifications?: () => void }> = {}) {
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const renderShell = (pathname: string) => act(async () =>
    root.render(
      <AppRouterContext value={router as never}>
        <RouterContext value={linkRouter}><PathnameContext value={pathname}>
          <AppShell portfolio={{ status: "ready", summary: { total_usd: 4760.34, today: null, breakdown: { coins: 3660.34, committed: 850, claimable: 250 } } }} overlays={<ActionHost onDeposit={onDeposit} onFund={onFund} onNotifications={onNotifications} />} onSignOut={onSignOut} signInHref="/sign-in" signedIn={signedIn} viewer={signedIn && !viewerLoading ? KAI : null} viewerLoading={viewerLoading}>
            <p>page</p>
          </AppShell>
        </PathnameContext></RouterContext>
      </AppRouterContext>,
    ),
  );
  await renderShell("/");
  t.after(async () => {
    await act(async () => root.unmount());
    container.parentNode?.removeChild(container);
    motion.all.length = 0;
    pushed.length = 0;
  });
  return async (pathname: string) => {
    await act(async () => root.render(null));
    await renderShell(pathname);
  };
}

const menuOf = (id: string) => document.getElementById(id);
/** The persistent header account and Create actions. */
const TRIGGERS = { [ACCOUNT_MENU_ID]: "button.topbarAvatar", [CREATE_MENU_ID]: "header button.createAction" } as const;
const button = (id: keyof typeof TRIGGERS) => document.querySelector<HTMLElement>(TRIGGERS[id]) as TestElement;
const rows = (id: string) => [...menuOf(id)!.querySelectorAll<HTMLElement>('[role="menuitem"]')];

/** Time for base-ui's frame and promise turns (animation frames are 16 ms timers here). */
async function frames(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}

/** A mouse press and release: the menus open on the click, as the gate's do. */
async function press(element: TestElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(testEvent("pointerdown", { button: 0, pointerType: "mouse" }));
    element.dispatchEvent(testEvent("mousedown", { button: 0 }));
    element.focus();
    element.dispatchEvent(testEvent("pointerup", { button: 0, pointerType: "mouse" }));
    element.dispatchEvent(testEvent("mouseup", { button: 0 }));
    element.dispatchEvent(testEvent("click", { button: 0, detail: 1 } as never));
  });
  await frames();
}

async function key(name: string): Promise<void> {
  await act(async () => void (document.activeElement as TestElement).dispatchEvent(testEvent("keydown", { key: name })));
  await frames();
}

async function mobileCreate(): Promise<{ more: TestElement; create: TestElement }> {
  const more = document.querySelector<TestElement>('nav[aria-label="Tabs"] button[aria-label="More"]')!;
  await press(more);
  const panel = document.getElementById(more.getAttribute("aria-controls")!);
  const create = panel!.querySelector<TestElement>('button[aria-haspopup="menu"]')!;
  return { more, create };
}

/** Time passes: every running animation reaches its end, and what waits on them (base-ui's unmount) runs too. */
async function settle(): Promise<void> {
  await act(async () => motion.finishAll());
  await frames();
}

for (const [name, id] of [
  ["account", ACCOUNT_MENU_ID],
  ["Create", CREATE_MENU_ID],
] as const) {
  test(`OA-31: the ${name} menu is visible on every opening, not only the first`, async (t) => {
    await mount(t);
    for (let opening = 1; opening <= 3; opening += 1) {
      await press(button(id));
      await settle();
      const menu = menuOf(id);
      assert.ok(menu, `opening ${opening} shows the menu`);
      assert.equal(motion.heldOpacity(menu), 1, `opening ${opening} leaves it opaque`);
      assert.equal(button(id).getAttribute("aria-expanded"), "true");
      await press(button(id));
      assert.equal(menuOf(id), menu, "it stays in view while it closes");
      assert.equal(button(id).getAttribute("aria-expanded"), "false");
      await settle();
      assert.equal(menuOf(id), null, `closing ${opening} takes it away`);
    }
  });

  test(`OA-31: the ${name} menu still closing is caught: pressed again, it opens and stays open`, async (t) => {
    await mount(t);
    const anchor = button(id);
    await press(anchor);
    await settle();
    const menu = menuOf(id)!;
    await press(anchor);
    const close = motion.all.at(-1)!;
    assert.equal(close.target, menu);
    assert.equal(close.fill, "forwards");
    assert.equal(close.playState, "running", "the menu is on its way out");
    await press(anchor);
    assert.equal(close.playState, "idle", "the reopening cancels the close, so its end never takes the menu away");
    await settle();
    assert.equal(menuOf(id), menu, "the same menu, never unmounted");
    assert.equal(motion.heldOpacity(menu), 1);
    assert.equal(anchor.getAttribute("aria-expanded"), "true");
  });
}

test("OA-31: the Create button closes the account menu as it opens its own: one close, which runs to its end", async (t) => {
  await mount(t);
  await press(button(ACCOUNT_MENU_ID));
  await settle();
  const account = menuOf(ACCOUNT_MENU_ID)!;
  const closes = () => motion.all.filter((animation) => animation.target === account && animation.fill === "forwards").length;
  await press(button(CREATE_MENU_ID));
  assert.equal(closes(), 1, "one close");
  assert.equal(button(ACCOUNT_MENU_ID).getAttribute("aria-expanded"), "false");
  await settle();
  assert.equal(menuOf(ACCOUNT_MENU_ID), null);
  assert.ok(menuOf(CREATE_MENU_ID));
  assert.equal(button(CREATE_MENU_ID).getAttribute("aria-expanded"), "true");
});

test("the account menu shows Profile, Invites, Settings, Appearance and Log out; Appearance keeps it open", async (t) => {
  let signedOut = 0;
  await mount(t, { onSignOut: async () => void (signedOut += 1) });
  await press(button(ACCOUNT_MENU_ID));
  await settle();
  const menu = menuOf(ACCOUNT_MENU_ID)!;
  assert.equal(menu.getAttribute("role"), "menu");
  assert.equal(menu.getAttribute("aria-label"), "Account");
  assert.equal(button(ACCOUNT_MENU_ID).getAttribute("aria-controls"), ACCOUNT_MENU_ID);
  assert.equal(button(ACCOUNT_MENU_ID).getAttribute("aria-label"), "Account menu");
  const items = rows(ACCOUNT_MENU_ID);
  assert.equal(items.length, 5);
  assert.ok(items.every((item) => item.localName === "button" && item.getAttribute("type") === "button"), "rows are buttons (the gate's button.mitem presses)");
  // Words only: no separators, and Log out does not repeat the handle.
  const order = [...menu.children].map((child) => (child.getAttribute("role") === "separator" ? "—" : child.textContent));
  assert.deepEqual(order.map((text) => text.replace(/(System|Light|Dark)$/, "")), [
    "Kai Moreno@kaimoreno",
    "Invites",
    "Settings",
    "Appearance",
    "Log out",
  ]);
  // The viewer's row: a 40px avatar first and a chevron last (the gate's `.mitem.acct-me`).
  assert.match(items[0]!.className, /\bacctMe\b/);
  assert.equal([...items[0]!.children].at(-1)!.localName, "svg");
  assert.equal([...items[0]!.children].at(-1)!.querySelector("path")!.getAttribute("d"), "m9 6 6 6-6 6");
  assert.equal(menu.querySelector(".wico"), null, "no item icons");
  assert.equal(document.activeElement, items[0], "the first item takes focus");
  assert.match(items[3]!.textContent, /^Appearance(System|Light|Dark)$/);
  const before = items[3]!.textContent;
  await press(items[3]!);
  assert.ok(menuOf(ACCOUNT_MENU_ID), "Appearance keeps the menu open, as the gate's theme-cycle does");
  assert.notEqual(rows(ACCOUNT_MENU_ID)[3]!.textContent, before, "and shows the next theme");
  assert.equal(items[4]!.textContent, "Log out");
  await press(rows(ACCOUNT_MENU_ID)[4]!);
  assert.equal(signedOut, 1);
  assert.equal(button(ACCOUNT_MENU_ID).getAttribute("aria-expanded"), "false", "a choice closes the menu");
});

test("UI-01 (§1.4): the viewer's row goes to their profile and closes the menu", async (t) => {
  await mount(t);
  await press(button(ACCOUNT_MENU_ID));
  await settle();
  await press(rows(ACCOUNT_MENU_ID)[0]!);
  assert.deepEqual(pushed, ["/@kaimoreno"]);
  await settle();
  assert.equal(menuOf(ACCOUNT_MENU_ID), null);
});

test("R3-73-AC-5: Settings goes to /settings and closes the menu (the gate's `go-settings`)", async (t) => {
  await mount(t);
  await press(button(ACCOUNT_MENU_ID));
  await settle();
  await press(rows(ACCOUNT_MENU_ID).find((item) => item.textContent === "Settings")!);
  assert.deepEqual(pushed, ["/settings"]);
  await settle();
  assert.equal(menuOf(ACCOUNT_MENU_ID), null);
});

test("background music keeps playing across navigation and tab switches until turned off", async (t) => {
  const audio = document.createElement("audio");
  let paused = true;
  Object.defineProperties(audio, {
    paused: { get: () => paused },
    play: { value: async () => { paused = false; audio.dispatchEvent(testEvent("play")); } },
    pause: { value: () => { paused = true; audio.dispatchEvent(testEvent("pause")); } },
  });
  Object.defineProperty(globalThis, "Audio", { value: function Audio() { return audio; }, configurable: true });
  t.after(() => { Reflect.deleteProperty(globalThis, "Audio"); });

  const navigate = await mount(t);
  const openAudioMenu = () => press(document.querySelector<TestElement>('button[aria-label="Audio"]')!);
  const musicItem = () => [...document.querySelectorAll<TestElement>('[role="menuitemcheckbox"]')]
    .find(item => item.textContent === "Background music")!;
  await openAudioMenu();
  await press(musicItem());
  assert.equal(audio.paused, false, "the listener starts the music");
  assert.equal(window.sessionStorage.getItem("blast.backgroundMusic"), "true", "a reload can recover the on choice");
  await navigate("/portfolio");
  assert.equal(audio.paused, false, "the route change keeps the same track playing");
  Object.defineProperty(document, "hidden", { value: true, configurable: true });
  try {
    await act(async () => { document.dispatchEvent(testEvent("visibilitychange")); });
    assert.equal(audio.paused, false, "switching browser tabs lets the track keep playing");
  } finally {
    Reflect.deleteProperty(document, "hidden");
  }
  await openAudioMenu();
  assert.equal(musicItem().getAttribute("aria-checked"), "true");
  await press(musicItem());
  assert.equal(audio.paused, true, "the listener can pause from the new page");
  assert.equal(window.sessionStorage.getItem("blast.backgroundMusic"), "false", "a reload also remembers the off choice");
});

test("phone More reveals Portfolio and Create, and dismisses safely", async (t) => {
  await mount(t, { signedIn: false });
  const more = document.querySelector<HTMLButtonElement>('nav[aria-label="Tabs"] button[aria-label="More"]')!;
  const panel = document.getElementById(more.getAttribute("aria-controls")!)!;
  await press(more);
  assert.ok(panel.closest('nav[aria-label="Tabs"]'));
  assert.equal(document.querySelector('header button[aria-label="More"]'), null);
  assert.deepEqual([...panel.querySelectorAll("a")].map((link) => link.getAttribute("href")), ["/portfolio"]);
  assert.equal(panel.querySelector('button[aria-haspopup="menu"]')?.textContent, "Create");
  const portfolio = panel.querySelector<HTMLAnchorElement>('a[href="/portfolio"]')!;
  portfolio.focus();
  await key("Escape");
  assert.equal(document.activeElement, more);
  assert.equal(more.getAttribute("aria-expanded"), "false");
  await press(more);
  await press(document.querySelector<HTMLButtonElement>('header button[aria-label="Search"]')!);
  assert.equal(more.getAttribute("aria-expanded"), "false");
  await press(more);
  assert.ok(!panel.closest('[role="dialog"], [role="menu"]'));
  await press(portfolio);
  assert.deepEqual(pushed, ["/portfolio"]);
  assert.equal(more.getAttribute("aria-expanded"), "false");
  assert.ok(panel.hasAttribute("inert"));
});

test("UI-20: the Create menu: Presale links to the Create page; Bonding curve links to Launch", async (t) => {
  await mount(t);
  await press(button(CREATE_MENU_ID));
  await settle();
  const [presale, curve] = rows(CREATE_MENU_ID);
  assert.equal(presale!.getAttribute("href"), "/create");
  assert.equal(curve!.localName, "a");
  assert.equal(curve!.getAttribute("href"), "/launch");
  assert.doesNotMatch(curve!.textContent, /Soon/);
});

test("the rail Create opens the shared choices beside the rail and Escape returns focus", async (t) => {
  await mount(t);
  const plus = document.querySelector('[data-shell-rail] [data-create-action]') as TestElement;
  await press(plus);
  await settle();
  assert.equal(plus.getAttribute("aria-expanded"), "true");
  assert.equal(document.querySelectorAll(`#${CREATE_MENU_ID}`).length, 1);
  assert.equal(rows(CREATE_MENU_ID)[0]!.getAttribute("href"), "/create");
  assert.equal(rows(CREATE_MENU_ID)[1]!.getAttribute("href"), "/launch");
  assert.equal(rows(CREATE_MENU_ID).length, 2);
  assert.equal(createMenuPlacement("rail").side, "right");
  assert.equal(createMenuPlacement("rail").align, "start");
  await key("Escape");
  await settle();
  assert.equal(menuOf(CREATE_MENU_ID), null);
  assert.equal(document.activeElement, plus);
  await press(button(CREATE_MENU_ID));
  await settle();
  assert.equal(button(CREATE_MENU_ID).getAttribute("aria-expanded"), "true");
  assert.equal(plus.getAttribute("aria-expanded"), "false");
});

test("signed out, every Create trigger opens the menu without signing in", async (t) => {
  await mount(t, { signedIn: false });
  const rail = document.querySelector<TestElement>('[data-shell-rail] [data-create-action]')!;
  for (const trigger of [button(CREATE_MENU_ID), rail]) {
    await press(trigger);
    await settle();
    assert.ok(menuOf(CREATE_MENU_ID));
    assert.deepEqual(pushed, []);
    await key("Escape");
    await settle();
  }
  const { more, create } = await mobileCreate();
  await press(create);
  assert.equal(rows(CREATE_MENU_ID).find((row) => row.getAttribute("href") === "/launch")?.localName, "a");
  assert.deepEqual(pushed, []);
  assert.equal(more.getAttribute("aria-expanded"), "true");
  await key("Escape");
  await settle();
  assert.equal(document.activeElement, create);
  await key("Escape");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, more);
});

test("Escape returns account focus to the top bar's avatar", async (t) => {
  await mount(t);
  const avatar = document.querySelector("button.topbarAvatar") as TestElement;
  await press(avatar);
  await settle();
  await key("Escape");
  await settle();
  assert.equal(menuOf(ACCOUNT_MENU_ID), null);
  assert.ok(document.activeElement === avatar, "focus returns to the avatar");
});

test("the top-bar Fund button opens Fund", async (t) => {
  let opened = 0;
  await mount(t, { onFund: () => { opened += 1; } });
  await press(document.querySelector("button.deposit") as TestElement);
  assert.equal(opened, 1);
});

test("mobile Create offers only launch choices while the session restores", async (t) => {
  await mount(t, { viewerLoading: true });
  const { create } = await mobileCreate();
  await press(create);
  await settle();
  const choices = rows(CREATE_MENU_ID);
  assert.equal(choices.length, 2);
  assert.match(choices[0]!.textContent, /^Presale/);
  assert.match(choices[1]!.textContent, /^Bonding curve/);
  assert.equal(document.activeElement, choices[0]);
  await key("Escape");
  await settle();
  assert.equal(menuOf(CREATE_MENU_ID), null);
  assert.equal(document.activeElement, create);
});

test("touch-open More closes when its navigation becomes hidden at a breakpoint", async (t) => {
  const original = window.matchMedia.bind(window);
  const breakpoint = new EventTarget();
  let matches = true;
  t.mock.method(window, "matchMedia", (query: string) => query === "(max-width: 760px)" ? {
    get matches() { return matches; },
    addEventListener: breakpoint.addEventListener.bind(breakpoint),
    removeEventListener: breakpoint.removeEventListener.bind(breakpoint),
  } as MediaQueryList : original(query));
  await mount(t, { signedIn: false });
  const more = document.querySelector<HTMLButtonElement>('nav[aria-label="Tabs"] button[aria-label="More"]')!;
  await press(more);
  more.blur();
  assert.equal(more.getAttribute("aria-expanded"), "true");
  await act(async () => {
    matches = false;
    breakpoint.dispatchEvent(new Event("change"));
  });
  assert.equal(more.getAttribute("aria-expanded"), "false");
});

test("balance breakdown shows the portfolio parts, masks them together, and restores keyboard focus", async (t) => {
  const { setShellPref } = await import("./use-shell-prefs");
  await mount(t);
  const trigger = document.querySelector("button.accountBalance") as TestElement;
  await press(trigger);
  const popup = document.querySelector(".balancePopup")!;
  for (const amount of ["$4,760.34", "$3,660.34", "$850.00", "$250.00"]) assert.ok(popup.textContent.includes(amount));
  await act(async () => setShellPref("amountsHidden", true));
  for (const amount of ["$4,760.34", "$3,660.34", "$850.00", "$250.00"]) assert.ok(!popup.textContent.includes(amount));
  assert.match(trigger.getAttribute("aria-label")!, /hidden/);
  await key("Escape");
  await settle();
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, trigger);
  await act(async () => setShellPref("amountsHidden", false));
});

test("the account-bar bell dispatches the existing notifications action", async (t) => {
  let opened = 0;
  await mount(t, { onNotifications: () => { opened += 1; } });
  const bell = document.querySelector("header button.nb") as TestElement;
  await press(bell);
  assert.equal(opened, 1);
  assert.equal(document.activeElement, bell);
  assert.equal(document.querySelector("nav[aria-label=Primary] [title=Notifications]"), null);
});
