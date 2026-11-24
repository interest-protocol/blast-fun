import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";
import { useHeaderSession, type HeaderSession } from "./use-header-session";

const { document } = installTestDom();
const { act } = await import("react");
const { hydrateRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { AppShell } = await import("#web/components/blast-ui/AppShell.tsx");
const router = { bfcacheId: "test", push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const viewer = { accountId: "pilot", callsign: "pilot", displayName: "Pilot", avatarUrl: null, verified: false };
const pending: HeaderSession = { signedIn: false, viewer: null, viewerLoading: true, viewerError: false };
const signedOut: HeaderSession = { ...pending, viewerLoading: false };
const signedIn: HeaderSession = { ...signedOut, signedIn: true, viewer };

function Header({ initial, live }: { initial: HeaderSession | null; live: HeaderSession }) {
  const session = useHeaderSession(initial, live, async () => {});
  return <AppRouterContext value={router}><PathnameContext value="/presale/test">
    <AppShell {...session} portfolio={{ status: "loading" }} signInHref="/sign-in" overlays={<button data-test-sign-out onClick={session.onSignOut} type="button">Log out</button>}><p>Presale</p></AppShell>
  </PathnameContext></AppRouterContext>;
}

test("signing out before provider readiness discards the verified server account", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<Header initial={signedIn} live={pending} />));
  assert.ok(container.querySelector('[aria-label="Account menu"]'));
  await act(async () => container.querySelector<HTMLButtonElement>("[data-test-sign-out]")!.click());
  assert.equal(Boolean(container.querySelector('[aria-label="Account menu"]')), false);
  assert.ok(container.querySelector(".accountPlaceholder"));
});

for (const initial of [signedIn, signedOut, null]) {
  test(`server ${initial?.signedIn ? "signed-in" : initial ? "signed-out" : "unknown"} state hydrates and hands off without reviving an old session`, async (t) => {
    const container = document.createElement("div");
    document.body.append(container);
    const tree = (live = pending) => <Header initial={initial} live={live} />;
    container.innerHTML = renderToString(tree());
    const header = container.querySelector("header")!;
    const checkInitial = () => {
      assert.equal(Boolean(header.querySelector('[aria-label="Account menu"]')), initial?.signedIn === true);
      assert.equal(header.textContent?.includes("Sign in"), initial?.signedIn === false);
      assert.equal(Boolean(header.querySelector(".accountPlaceholder")), initial === null);
      assert.doesNotMatch(header.textContent ?? "", /\$0\.00/);
    };
    checkInitial();
    const errors: unknown[] = [];
    const root = hydrateRoot(container, tree(), { onRecoverableError: (error) => errors.push(error) });
    t.after(async () => { await act(async () => root.unmount()); container.remove(); });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    checkInitial();
    await act(async () => root.render(tree(signedIn)));
    assert.ok(header.querySelector('[aria-label="Account menu"]'));
    await act(async () => root.render(tree(signedOut)));
    assert.ok(header.textContent?.includes("Sign in"));
    await act(async () => root.render(tree(pending)));
    assert.ok(header.querySelector(".accountPlaceholder"), "a later login must not reuse the original server account");
    assert.equal(Boolean(header.querySelector('[aria-label="Account menu"]')), false);
    await act(async () => root.render(tree({ ...signedIn, viewer: { ...viewer, accountId: "another", callsign: "another" } })));
    assert.equal(container.querySelector("header"), header);
    assert.ok(header.querySelector('[aria-label="Account menu"]'));
    assert.deepEqual(errors, []);
  });
}
