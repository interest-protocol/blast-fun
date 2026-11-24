import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";
import type { AppShellProps } from "./AppShell";

const { document } = installTestDom();
const { act } = await import("react");
const { hydrateRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { AppShell } = await import("./AppShell");

const router = { bfcacheId: "test", push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const viewer = { accountId: "kai", callsign: "kai", displayName: "Kai", avatarUrl: null, verified: true };

for (const signedIn of [false, true]) {
  test(`unresolved header hydrates, waits, and resolves ${signedIn ? "signed in" : "signed out"} without remounting`, async (t) => {
    const container = document.createElement("div");
    container.setAttribute("data-blast-ui", "");
    document.body.append(container);
    const errors: unknown[] = [];
    const tree = (props: Partial<AppShellProps> = {}, path = "/presale/0x1") => (
      <AppRouterContext value={router}>
        <PathnameContext value={path}>
          <AppShell portfolio={{ status: "loading" }} signInHref="/sign-in" signedIn={false} viewer={null} viewerLoading {...props}>
            <p>page</p>
          </AppShell>
        </PathnameContext>
      </AppRouterContext>
    );
    container.innerHTML = renderToString(tree());
    const header = container.querySelector("header")!;
    const pending = () => {
      const placeholder = header.querySelector('.accountPlaceholder[aria-hidden="true"]');
      assert.ok(placeholder);
      assert.equal(placeholder.children.length, 0);
      assert.equal(placeholder.getAttribute("tabindex"), null);
      assert.doesNotMatch(header.textContent ?? "", /Fund|Sign in|\$0\.00/);
      assert.equal(header.querySelector('[aria-label="Account menu"], [data-nav-bal]'), null);
    };
    pending();
    const root = hydrateRoot(container, tree(), { onRecoverableError: (error) => errors.push(error) });
    t.after(async () => {
      await act(async () => root.unmount());
      container.remove();
    });
    await act(async () => {});
    pending();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    pending();
    const resolved = { signedIn, viewer: signedIn ? viewer : null, viewerLoading: false };
    await act(async () => root.render(tree(resolved)));
    assert.equal(header.querySelector(".accountPlaceholder"), null);
    assert.equal(Boolean(header.querySelector('[aria-label="Account menu"]')), signedIn);
    assert.equal(header.textContent?.includes("Sign in"), !signedIn);
    assert.doesNotMatch(header.textContent ?? "", /\$0\.00/);

    // The shared layout keeps the session and header through client navigation.
    await act(async () => root.render(tree(resolved, "/portfolio")));
    assert.equal(container.querySelector("header"), header);
    assert.equal(header.querySelector(".accountPlaceholder"), null);
    assert.equal(Boolean(header.querySelector('[aria-label="Account menu"]')), signedIn);

    await act(async () => root.render(tree({ signedIn: !signedIn, viewer: signedIn ? null : viewer, viewerLoading: false })));
    assert.equal(Boolean(header.querySelector('[aria-label="Account menu"]')), !signedIn);
    assert.equal(header.textContent?.includes("Sign in"), signedIn);
    assert.deepEqual(errors, []);
  });
}
