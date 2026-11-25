import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { FeelProvider } from "#web/components/blast-feel/FeelProvider.tsx";
import { CoinPageWallet } from "./CoinPageWallet";
import { AppShell } from "./AppShell";
import type { PortfolioSummaryState } from "./portfolio";
import type { ShellViewer } from "./shell-viewer";
import { shellViewerOf } from "./shell-viewer";

const router = { push: () => undefined, replace: () => undefined, prefetch: () => undefined } as unknown as AppRouterInstance;
const at = (pathname: string, node: ReactNode) =>
  renderToStaticMarkup(
    <AppRouterContext value={router}>
      <PathnameContext value={pathname}>{node}</PathnameContext>
    </AppRouterContext>,
  );

const KAI: ShellViewer = { accountId: "a-kai", callsign: "kaimoreno", displayName: "Kai Moreno", avatarUrl: null, verified: true };

const READY: PortfolioSummaryState = { status: "ready", summary: { total_usd: 4_760.34, today: { usd: 224.81, pct: 4.96 } } };

function shell(props: Partial<Parameters<typeof AppShell>[0]> = {}, pathname = "/feed"): string {
  return at(
    pathname,
    <FeelProvider>
      <AppShell portfolio={READY} signInHref="/sign-in?next=%2F" signedIn viewer={KAI} {...props}>
        <p>page</p>
      </AppShell>
    </FeelProvider>,
  );
}

test("the rail holds its six destinations and the shared Create trigger; Search and one Audio menu share the top bar", () => {
  const html = shell();
  const rail = html.slice(html.indexOf('<nav aria-label="Primary"'), html.indexOf('class="railSpacer"'));
  assert.match(rail, /<a aria-label="Blast home"[^>]*href="\/"/);
  assert.deepEqual([...rail.matchAll(/title="([^"]+)"/g)].map((match) => match[1]), ["Collapse"]);
  for (const label of ["Home", "Swap", "Bonding", "Presales", "Portfolio", "More", "Competitions", "Create"]) {
    assert.ok(rail.includes(`>${label}<`));
  }
  assert.match(rail, /<a aria-current="page" class="navItem" href="\/">/);
  assert.match(rail, /<button(?=[^>]*aria-haspopup="dialog")(?=[^>]*aria-label="Swap")(?=[^>]*class="navItem")[^>]*><svg[^>]*>.*?<\/svg><span>Swap<\/span><\/button>/s);
  assert.doesNotMatch(rail, /<kbd>/, "no key hints in the rail");
  const document = new JSDOM(html).window.document;
  const audio = document.querySelectorAll('button[aria-label="Audio"]');
  assert.equal(audio.length, 1);
  assert.equal(audio[0]!.previousElementSibling?.getAttribute("aria-label"), "Search");
  assert.equal(audio[0]!.getAttribute("aria-haspopup"), "menu");
  assert.equal(audio[0]!.querySelector("svg")?.getAttribute("aria-hidden"), "true");
  assert.equal(document.querySelector("audio")?.getAttribute("preload"), "none");
  assert.equal(document.querySelector("audio")?.getAttribute("src"), null, "never requests the track on page load");
  const bar = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  assert.match(bar, /<button(?=[^>]*aria-keyshortcuts="\/")(?=[^>]*aria-label="Search")(?=[^>]*title="Search \(\/\)")[^>]*>/);
  assert.match(rail, /<button(?=[^>]*aria-label="Create")(?=[^>]*aria-haspopup="menu")(?=[^>]*class="navItem railCreate")[^>]*><svg[^>]*>.*?<\/svg><span>Create<\/span><\/button>/s);
  assert.match(rail, /class="navItem" href="\/portfolio">/);
  assert.ok(!rail.includes('title="Profile"') && !rail.includes('title="Settings"'), "Profile and Settings left the rail");
  assert.ok(!rail.includes("Notifications"));
  // Collapse toggle as the server renders it (the device's choice arrives after hydration).
  assert.match(rail, /<button aria-expanded="true" aria-label="Collapse sidebar"[^>]*class="button iconButton railToggle"[^>]*data-ui-size="chip" data-ui-variant="ghost"/);
});

test("the account bar groups portfolio value before Fund, then notifications and account", () => {
  const html = shell();
  const rail = html.slice(html.indexOf('<nav aria-label="Primary"'), html.indexOf("</nav>"));
  assert.ok(!rail.includes("data-nav-bal") && !rail.includes("Fund"));
  const bar = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.doesNotMatch(bar, /Total balance/);
  assert.match(bar, /data-nav-bal=""><span class="balanceExact">\$4,760\.34<\/span>/);
  assert.ok(bar.indexOf("data-nav-bal") < bar.indexOf("Fund") && bar.indexOf("Fund") < bar.indexOf("Notifications") && bar.indexOf("Notifications") < bar.indexOf("Account menu"));
  // Persistent chrome stays neutral: each page keeps its own one pink primary.
  assert.match(bar, /<button type="button" class="button deposit" data-ui-button="" data-ui-size="chip" data-ui-variant="secondary">Fund<\/button>/);
  assert.match(bar, /<button(?=[^>]*aria-label="Portfolio value, \$4,760\.34)(?=[^>]*data-ui-size="chip")(?=[^>]*data-ui-disclosure="")[^>]*class="button accountBalance"/);
  for (const pathname of ["/feed", "/presale", "/portfolio", "/notifications", "/competitions", "/create"]) {
    assert.equal(new JSDOM(shell({}, pathname)).window.document.querySelector("main .pageWallet"), null);
  }
  const coin = at("/coin/0x1", <AppShell portfolio={READY} signInHref="/sign-in" signedIn viewer={KAI}><div><a href="/bonding">Back</a><CoinPageWallet /></div><h1>Coin detail</h1></AppShell>);
  const coinMain = new JSDOM(coin).window.document.querySelector("main")!;
  const coinWallet = coinMain.querySelector(".pageWallet")!;
  assert.match(coinWallet.textContent!, /\$4,760\.34.*Fund/);
  assert.equal(coinWallet.previousElementSibling?.textContent, "Back");
  assert.equal(coinMain.querySelectorAll(".pageWallet").length, 1);
  assert.ok(!bar.includes('USD') && !bar.includes('today'));
  assert.match(shell({}, "/portfolio"), /<a aria-current="page" class="navItem" href="\/portfolio">/);
});

test("the site's shell has no Blast Mode control", () => {
  const { document } = new JSDOM(shell()).window;
  assert.equal(document.querySelector('[aria-label="Blast mode" i]'), null);
  assert.equal(document.querySelector('[aria-keyshortcuts="B F"]'), null);
});

test("balance loading, unavailable and zero states retain the amount control without a label", () => {
  for (const portfolio of [{ status: "loading" }, { status: "unavailable" }, { status: "ready", summary: { total_usd: 0, today: null } }] as const) {
    const html = shell({ portfolio });
    const bar = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.match(bar, />Fund<\/button>/);
    assert.doesNotMatch(bar, /Total balance/);
    if (portfolio.status === "loading") {
      assert.match(bar, /Portfolio value, Loading…/);
      assert.match(bar, /data-nav-bal=""><span aria-hidden="true" class="balancePlaceholder"><\/span>/);
    } else {
      const expected = portfolio.status === "unavailable" ? "Unavailable" : "$0.00";
      assert.ok(bar.includes(`class="balanceExact">${expected}</span>`));
    }
  }
});

test("one notification bell in the account bar exposes unread state and retains page navigation", () => {
  const html = shell({ unreadCount: 3 });
  const bar = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  assert.match(bar, /<button aria-label="Notifications, 3 unread" title="Notifications" data-ui-icon="" type="button" class="button iconButton nb" data-ui-button="" data-ui-size="chip" data-ui-variant="ghost">.*?<em aria-hidden="true" class="badgeDot">3<\/em>/s);
  assert.equal([...html.matchAll(/title="Notifications"/g)].length, 1);
  assert.ok(!html.includes("data-unread"));
  const none = shell({ unreadCount: 0 });
  assert.match(none, /aria-label="Notifications"[^>]*class="button iconButton nb"/);
  assert.ok(!none.includes("badgeDot"));
  assert.match(shell({ unreadCount: 100 }), /class="badgeDot">99\+<\/em>/);
  const page = shell({ notificationsHref: "/notifications" }, "/notifications");
  // The page link is the shared icon link at the chip size, the same control as the button form.
  assert.match(page, /<a(?=[^>]*aria-current="page")(?=[^>]*aria-label="Notifications")(?=[^>]*class="button iconButton nb")(?=[^>]*data-ui-size="chip")(?=[^>]*data-ui-variant="ghost")(?=[^>]*href="\/notifications")[^>]*>/);
  assert.ok(!page.includes('class="icon-btn nb"'), "the bell no longer uses the legacy square");
  for (const props of [{ signedIn: false, viewer: null }, { signedIn: true, viewer: null, viewerLoading: true }]) {
    assert.equal([...shell(props).matchAll(/title="Notifications"/g)].length, 1);
  }
});

test("Presales and Bonding have distinct links, icons, and current states in both menus", () => {
  const document = new JSDOM(shell({}, "/bonding")).window.document;
  for (const name of ["Primary", "Tabs"]) {
    const nav = document.querySelector(`nav[aria-label="${name}"]`)!;
    const presales = nav.querySelector('a[href="/presale"]')!;
    const bonding = nav.querySelector('a[href="/bonding"]')!;

    assert.equal(presales.textContent, "Presales");
    assert.equal(bonding.textContent, "Bonding");
    assert.equal(presales.getAttribute("aria-current"), null);
    assert.equal(bonding.getAttribute("aria-current"), "page");
    assert.ok(presales.querySelector('svg[aria-hidden="true"]'));
    assert.ok(bonding.querySelector('svg[aria-hidden="true"]'));
    assert.notEqual(presales.querySelector("svg")!.innerHTML, bonding.querySelector("svg")!.innerHTML);
  }


});

test("signed in: the account menu has one trigger, the top bar's avatar, where a visitor sees Sign in", () => {
  const html = shell();
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll('button[aria-label="Account menu"]').length, 1);
  assert.ok(document.querySelector('header button.topbarAvatar[aria-label="Account menu"]'));
  assert.equal(document.querySelector('nav[aria-label="Primary"] [aria-label="Account menu"]'), null);
  assert.match(html, /class="button deposit"/);
  assert.ok(!html.includes(">Sign in<"));
  const visitor = new JSDOM(shell({ signedIn: false, viewer: null })).window.document;
  assert.equal(visitor.querySelector('[aria-label="Account menu"]'), null);
  assert.ok(visitor.querySelector("header a.topbarSignin"));
});

test("the account avatar marks the viewer's profile and Settings", () => {
  for (const path of ["/@kaimoreno", "/crew/kaimoreno", "/settings"]) {
    const document = new JSDOM(shell({}, path)).window.document;
    assert.equal(document.querySelector("button.topbarAvatar")?.getAttribute("data-current"), "true", path);
  }
  for (const path of ["/", "/portfolio", "/@nova"]) {
    const document = new JSDOM(shell({}, path)).window.document;
    assert.equal(document.querySelector('button.topbarAvatar[data-current="true"]'), null, path);
  }
});



test("visitors get one Sign in and no private balance; session loading never flashes Sign in", () => {
  const html = shell({ signedIn: false, viewer: null });
  assert.match(html, /class="btn btn-ink topbarSignin" href="\/sign-in\?next=%2F">Sign in<\/a>/);
  assert.equal([...html.matchAll(/>Sign in</g)].length, 1);
  assert.doesNotMatch(html, /Sign in to see your wallet|class="accountMessage"/);
  assert.ok(!html.includes('data-nav-bal') && !html.includes('Fund'));
  for (const props of [{ signedIn: true, viewer: null }, { signedIn: false, viewer: null, viewerLoading: true }]) {
    const loading = shell(props);
    assert.ok(!loading.includes('>Sign in<') && !loading.includes('data-nav-bal'));
  }
});

test("unresolved authentication shows only a quiet, inaccessible account placeholder", () => {
  for (const signedIn of [false, true]) {
    for (const viewer of [null, KAI]) {
      const html = shell({ signedIn, viewer, viewerLoading: true });
      const bar = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
      assert.match(bar, /<div aria-hidden="true" class="accountPlaceholder"><\/div>/);
      assert.doesNotMatch(bar, /Fund|balancePlaceholder|avatarPlaceholder|Account menu|Sign in|data-nav-bal|\$0\.00|role="status"|Loading (?:account|balance|profile)/);
      assert.equal([...bar.matchAll(/<button/g)].length, 4, "The shell renders Search, Audio, Notifications and Create");
    }
  }
});



test("UI-01: Home's right column has its header and the collapse/expand pair; other pages hold only their cards", () => {
  const home = shell({ aside: <div className="card">x</div> });
  assert.match(home, /<aside aria-label="Trending coins"[^>]*id="aside"/);
  assert.match(home, /<h2>Trending coins<\/h2><span class="asideActs"><button aria-controls="aside" aria-expanded="true" aria-label="Collapse trending coins"[^>]*title="Collapse"/);
  assert.match(home, /aria-label="Expand trending coins"[^>]*title="Expand"/);
  // R3-77 (OA-41 `.ah-acts`): the column's own controls come before the collapse button.
  const withActions = shell({ aside: <div className="card">x</div>, asideActions: <button data-cards="" type="button" /> });
  assert.match(withActions, /<h2>Trending coins<\/h2><span class="asideActs"><button data-cards="" type="button"><\/button><button aria-controls="aside"[^>]*aria-label="Collapse trending coins"/);
  assert.ok(!shell({ aside: <div className="card">x</div>, asideActions: <button data-cards="" type="button" /> }, "/settings").includes("data-cards"), "only Home's column has a header");
  assert.match(home, /data-home="true"/);
  const settings = shell({ aside: <div className="card">wallet</div> }, "/settings");
  assert.ok(!settings.includes("Collapse trending coins"));
});

test("the phone bar keeps five controls with Swap second and profile available in the account menu", () => {
  const tabsOf = (html: string) => html.slice(html.indexOf('<nav aria-label="Tabs"'), html.indexOf('</nav>', html.indexOf('<nav aria-label="Tabs"')));
  const tabs = tabsOf(shell({}, "/settings"));
  const nav = new JSDOM(tabs).window.document.querySelector('nav[aria-label="Tabs"]')!;
  const controls = [...nav.querySelectorAll("a, button")].filter((control) => !control.closest("[inert]"));
  assert.deepEqual(controls.map((control) => control.getAttribute("aria-label") ?? control.textContent), ["Home", "Swap", "Bonding", "Presales", "More"]);
  assert.ok(nav.querySelector('[inert] button[aria-haspopup="menu"]')?.textContent === "Create");
  assert.match(tabs, /aria-hidden="true" inert=""/);
  assert.doesNotMatch(shell().slice(shell().indexOf("<header"), shell().indexOf("</header>")), /aria-label="More"/);
  assert.doesNotMatch(tabs, /aria-current="page"|Profile/);
  assert.match(shell({}, "/settings"), /aria-label="Account menu"/);
  assert.ok(!tabs.includes("Settings") && !tabs.includes('href="/settings"'));
  assert.match(tabsOf(shell({}, "/portfolio")), /<a aria-current="page"[^>]*href="\/portfolio">/);
  assert.match(tabsOf(shell({}, "/portfolio")), /data-current="true" data-more-navigation/);
  assert.match(tabsOf(shell({}, "/presale")), /<a aria-current="page" href="\/presale">/);
  assert.doesNotMatch(tabsOf(shell({}, "/@kaimoreno")), /aria-current="page"/);
  for (const props of [{ signedIn: false, viewer: null }, { signedIn: false, viewer: null, viewerLoading: true }]) {
    assert.match(tabsOf(shell(props)), /aria-label="Swap"/);
  }
});

test("an account failure or missing signed-in account offers retry without an onboarding step", () => {
  const error = shell({ viewer: null, viewerError: true, onRetryAccount: () => undefined });
  assert.match(error, /Your account could not load/);
  assert.match(error, />Try again<\/button>/);
  assert.doesNotMatch(error, /Loading profile|>Sign in</);
  const missing = shell({ viewer: null });
  assert.match(missing, />Try again<\/button>/);
  assert.doesNotMatch(missing, /Loading profile|>Sign in<|Set up/);
});

test("UI-20: an accessible icon-only Create action precedes the profile and opens the existing menu", () => {
  const html = shell();
  const bar = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.match(bar, /<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-label="Create"[^>]*class="icon-btn createAction"[^>]*><svg[^>]*>.*?<\/svg><\/button><button[^>]*class="topbarAvatar"/s);
  assert.equal([...html.matchAll(/title="Create"/g)].length, 1);
  assert.doesNotMatch(html, /createFab/);
  for (const path of ["/create", "/presale/0x1", "/portfolio", "/settings"]) {
    const html = shell({}, path);
    assert.equal([...html.matchAll(/<button(?=[^>]*data-create-action="")[^>]*>/g)].length, 2);
    assert.doesNotMatch(html, /<button(?=[^>]*data-create-action="")(?=[^>]*hidden="")[^>]*>/);
  }
  assert.ok(!html.includes('role="menu"') && !html.includes("blast-create-menu") && !html.includes("blast-account-menu"));
  assert.doesNotMatch(html, / style="/, "no inline style reaches the server's HTML (ui-libraries §2.1)");
  // A visitor sees Create too (the design's GATED list: it asks to sign in).
  assert.match(shell({ signedIn: false, viewer: null }), /title="Create"/);
});



test("UI-01 (OA-8): the shell's viewer from `me`: verified means X is linked", () => {
  const me = { account_id: "a1", callsign: "kai", display_name: "Kai", avatar_url: null, verified: true };
  assert.deepEqual(shellViewerOf(me), { accountId: "a1", callsign: "kai", displayName: "Kai", avatarUrl: null, verified: true });
  assert.equal(shellViewerOf({ ...me, verified: false }).verified, false);
});


test("the collapsed expand button precedes the coin stack in DOM order", () => {
  const html = shell({ aside: <div className="card">x</div>, asideMini: <div aria-label="Your coins">coins</div> });
  assert.ok(html.indexOf('aria-label="Expand trending coins"') < html.indexOf('aria-label="Your coins"'));
});

test("the presale catalog and competitions use full width while presale details retain their aside", () => {
  for (const path of ["/presale", "/competitions", "/competitions/sui-week"]) {
    const catalog = shell({ aside: <p>Presale rail</p> }, path);
    assert.match(catalog, /data-no-aside="true"/);
    assert.doesNotMatch(catalog, /Presale rail/);
  }
  assert.match(shell({ aside: <p>Presale rail</p> }, "/presale/project"), /Presale rail/);
});

test("the avatar is a 36px chip (44px on touch and phones)", async () => {
  const { readFileSync } = await import("#web/test/css-design-px.ts");
  const css = readFileSync(new URL("./AppShell.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.topbarAvatar \{[^}]*width: 36px;[^}]*height: 36px;/);
  assert.match(css, /@media \(max-width: 760px\), \(pointer: coarse\) \{\s*\.topbarAvatar \{ width: 44px; height: 44px; \}/);
});
