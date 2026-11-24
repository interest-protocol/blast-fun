import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom, recordAnimations } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const motion = recordAnimations();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { AppShell } = await import("./AppShell");
const { FixtureCoinsHost } = await import("../../../test/fixtures/social/coins/CoinsFixture.tsx");

for (const navigation of ["Primary", "Tabs"]) {
  test(`${navigation} Swap opens the existing USDC to SUI modal without navigating and returns focus on close`, async (t) => {
    const container = document.createElement("div");
    container.setAttribute("data-blast-ui", "");
    document.body.appendChild(container);
    const root = createRoot(container);
    const push = t.mock.fn();
    const router = { push, replace: t.mock.fn(), prefetch() {} };
    t.after(async () => {
      await act(async () => root.unmount());
      container.remove();
      motion.all.length = 0;
    });

    await act(async () => root.render(
      <AppRouterContext value={router as never}>
        <PathnameContext value="/presale">
          <AppShell
            overlays={<FixtureCoinsHost />}
            portfolio={{ status: "unavailable" }}
            signInHref="/sign-in"
            signedIn={false}
            viewer={null}
          >
            <p>Presales page</p>
          </AppShell>
        </PathnameContext>
      </AppRouterContext>,
    ));

    const trigger = container.querySelector<HTMLButtonElement>(`nav[aria-label="${navigation}"] button[aria-label="Swap"]`)!;
    await act(async () => { trigger.focus(); trigger.click(); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    assert.ok(dialog);
    assert.ok(dialog.querySelector('[aria-label="Change sell token (USDC)"]'));
    assert.ok(dialog.querySelector('[aria-label="Change receive token (SUI)"]'));
    assert.ok(dialog.querySelector("[data-trade]"));
    assert.equal(container.querySelector('nav[aria-label="Primary"] [aria-current="page"]')?.textContent, "Presales");
    assert.equal(push.mock.callCount(), 0);
    assert.equal(router.replace.mock.callCount(), 0);

    await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    await act(async () => motion.finishAll());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    assert.equal(document.querySelector('[role="dialog"][aria-modal="true"]'), null);
    assert.equal(document.activeElement, trigger);
    assert.match(container.textContent ?? "", /Presales page/);
  });
}
