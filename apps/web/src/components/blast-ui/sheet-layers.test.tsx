import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { useState } from "react";

import { installTestDom, recordAnimations, testEvent, TestElement } from "../../../test/fixtures/social/test-dom.ts";

/**
 * OA-31: two sheets on the page at once. The shell's overlays are in a fixed
 * order (`SocialShell`: sign-in first, the coin sheet, then the commit and
 * sale dialogs), so the DOM said which sheet was on top, not which opened
 * last:
 *
 * - **Commit → Deposit** (`CommitHost`'s `openDeposit`: `close()` and
 *   `run("openDeposit")` in one tick). For the commit sheet's 220 ms close
 *   its scrim covered the coin sheet, the end of the close unlocked the page
 *   and focused the commit sheet's opener, Escape and Tab went to the
 *   closing sheet, and the coin sheet's own return target (the Deposit
 *   button) left with the commit sheet, so closing it dropped focus on the
 *   page.
 * - **A signed-out "Notify me"** opened sign-in beneath the sale dialog,
 *   where Escape could not reach it.
 *
 * The rule is now the gate's: the sheet opened last is on top. These render
 * the real `Sheet` in the app shell's overlays, in that order, with stand-ins
 * that open and close them the way the hosts do.
 */

const { document } = installTestDom();
const motion = recordAnimations();
// jsdom has no layout; the rendered controls in this fixture have visible parents.
Object.defineProperty(TestElement.prototype, "offsetParent", { configurable: true, get() { return this.isConnected ? this.parentElement : null; } });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { AppShell } = await import("./AppShell");
const { Sheet, SheetClose } = await import("./Sheet");
const { useShellAction, useShellActions } = await import("./shell-actions");

const router = { push: () => undefined, replace: () => undefined, refresh: () => undefined, back: () => undefined, forward: () => undefined, prefetch: () => undefined };

/** A sheet a shell action opens (`CoinsHost`'s `openDeposit`, the sign-in sheet's `openSignIn`). */
function ActionSheet({ action, title, focus }: Readonly<{ action: "openDeposit" | "openSignIn"; title: string; focus: string }>) {
  const [open, setOpen] = useState(false);
  useShellAction(action, () => setOpen(true));
  return (
    <Sheet initialFocus={() => document.querySelector<HTMLElement>(`[data-focus="${focus}"]`) as unknown as HTMLElement | null} labelledBy={`${focus}-title`} onRequestClose={() => setOpen(false)} open={open}>
      <SheetClose onClick={() => setOpen(false)} />
      <h2 id={`${focus}-title`}>{title}</h2>
      <button data-focus={focus} type="button">
        {title}
      </button>
    </Sheet>
  );
}

/** A dialog the page opens (`CommitHost`'s commit or sale dialog), with one button that runs a shell action the way the host does. */
function HostSheet({ open, onClose, title, label, then }: Readonly<{ open: boolean; onClose: () => void; title: string; label: string; then: "deposit" | "notify" }>) {
  const run = useShellActions();
  const press = () => {
    if (then === "deposit") {
      // `CommitHost`'s `openDeposit`: the commit dialog closes and the coin sheet opens in the same tick.
      onClose();
      run("openDeposit", "usdc");
    } else run("openSignIn"); // `NotifyingSaleDialog`, signed out: the sale dialog stays.
  };
  return (
    <Sheet labelledBy={`${then}-host-title`} onRequestClose={onClose} open={open}>
      <SheetClose onClick={onClose} />
      <h2 id={`${then}-host-title`}>{title}</h2>
      <button data-host={then} onClick={press} type="button">
        {label}
      </button>
    </Sheet>
  );
}

/** The page and the shell's overlays in `SocialShell`'s order: sign-in, the coin sheet, then the commit and sale dialogs. */
function Page() {
  const [commit, setCommit] = useState(false);
  const [sale, setSale] = useState(false);
  return (
    <AppShell
      overlays={
        <>
          <ActionSheet action="openSignIn" focus="sign-in" title="Join Blast" />
          <ActionSheet action="openDeposit" focus="coin" title="Deposit USDC" />
          <HostSheet label="Add USDC" onClose={() => setCommit(false)} open={commit} then="deposit" title="Blast Meridian" />
          <HostSheet label="Notify me" onClose={() => setSale(false)} open={sale} then="notify" title="Tidal" />
        </>
      }
      portfolio={{ status: "unavailable" }}
      signInHref="/sign-in"
      signedIn={false}
      viewer={null}
    >
      <button data-page="commit" onClick={() => setCommit(true)} type="button">
        Blast
      </button>
      <button data-page="sale" onClick={() => setSale(true)} type="button">
        View presale
      </button>
    </AppShell>
  );
}

async function mount(t: TestContext): Promise<void> {
  // The Blast UI root, where the sheets portal (OA-28 M2: `usePortalContainer`).
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <AppRouterContext value={router as never}>
        <PathnameContext value="/">
          <Page />
        </PathnameContext>
      </AppRouterContext>,
    ),
  );
  t.after(async () => {
    await act(async () => root.unmount());
    container.parentNode?.removeChild(container);
    assert.equal(document.body.style.overflow, "", "leaving the page leaves it unlocked");
  });
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector) as TestElement;
const dialog = (title: string) => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((sheet) => sheet.textContent.includes(title))!;
const scrim = (title: string) => dialog(title).parentElement!;
const z = (title: string) => Number(scrim(title).style.zIndex);
const modal = () => [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].map((sheet) => sheet.querySelector<HTMLElement>("h2")!.textContent);

/** Compares by identity: a failing `assert.equal` would print the whole tree. */
function focused(element: TestElement | null, message: string): void {
  assert.ok(element !== null && document.activeElement === element, message);
}

async function click(element: TestElement): Promise<void> {
  element.focus();
  await act(async () => element.click());
}

async function key(name: string, shiftKey = false): Promise<void> {
  const target = document.activeElement ?? document.body;
  await act(async () => void target.dispatchEvent(testEvent("keydown", { key: name, shiftKey, metaKey: false, ctrlKey: false, altKey: false })));
}

/** Time passes: every motion reaches its end. */
async function settle(): Promise<void> {
  await act(async () => motion.finishAll());
}

test("OA-31: Commit → Deposit: the closing commit sheet is no longer a layer, and the coin sheet is on top, focused and holding the page", async (t) => {
  await mount(t);
  await click($('[data-page="commit"]'));
  await settle();
  await click($('[data-host="deposit"]'));

  assert.ok(z("Deposit USDC") > z("Blast Meridian"), "the coin sheet, opened last, is drawn above the closing commit sheet");
  assert.equal(scrim("Blast Meridian").getAttribute("data-closing"), "", "the closing scrim lets presses through");
  assert.equal(scrim("Deposit USDC").getAttribute("data-closing"), null);
  assert.deepEqual(modal(), ["Deposit USDC"], "only the coin sheet is a modal layer");
  focused($('[data-focus="coin"]'), "the coin sheet takes focus");
  assert.equal(document.body.style.overflow, "hidden");

  // Tab is trapped in the coin sheet, not handed to the closing one.
  await key("Tab");
  focused(dialog("Deposit USDC").querySelector<HTMLElement>('[aria-label="Close"]'), "Tab wraps inside the coin sheet");

  await settle();
  assert.equal([...document.querySelectorAll<HTMLElement>('[role="dialog"]')].length, 1, "the commit sheet is gone");
  assert.equal(document.body.style.overflow, "hidden", "its end does not unlock the page under the coin sheet");
  assert.ok(dialog("Deposit USDC").contains(document.activeElement), "nor take focus back to the page");

  await key("Escape");
  await settle();
  assert.equal([...document.querySelectorAll<HTMLElement>('[role="dialog"]')].length, 0);
  assert.equal(document.body.style.overflow, "");
  focused($('[data-page="commit"]'), "the Deposit button left with the commit sheet: focus goes to what opened that sheet, not to <body>");
});

test("OA-31: Escape during the handoff closes the coin sheet, the one on top", async (t) => {
  await mount(t);
  await click($('[data-page="commit"]'));
  await settle();
  await click($('[data-host="deposit"]'));
  await key("Escape");
  assert.deepEqual(modal(), [], "the coin sheet heard it");
  assert.equal(scrim("Deposit USDC").getAttribute("data-closing"), "");
  await settle();
  focused($('[data-page="commit"]'), "both gone, focus is back where the commit sheet was opened");
  assert.equal(document.body.style.overflow, "");
});

test("OA-31: a signed-out Notify me opens sign-in on top of the sale dialog, and Escape reaches it", async (t) => {
  await mount(t);
  await click($('[data-page="sale"]'));
  await settle();
  await click($('[data-host="notify"]'));
  await settle();

  assert.ok(z("Join Blast") > z("Tidal"), "sign-in, first in the overlays but opened last, is drawn above the sale dialog");
  // Both are modal layers. In the page's order, which is now the order they opened: each portals to the end of the Blast UI root (OA-28 M2).
  assert.deepEqual(modal(), ["Tidal", "Join Blast"]);
  focused($('[data-focus="sign-in"]'), "sign-in takes focus");

  await key("Escape");
  assert.deepEqual(modal(), ["Tidal"], "Escape closed sign-in, not the sale dialog");
  await settle();
  focused($('[data-host="notify"]'), "focus is back on Notify me, in the sale dialog");
  assert.equal(document.body.style.overflow, "hidden", "the sale dialog still holds the page");

  await key("Escape");
  await settle();
  focused($('[data-page="sale"]'), "and then on the page's button");
  assert.equal(document.body.style.overflow, "");
});

test("OA-31: a closing sheet takes no presses (the scrim and the sheet are pinned to `pointer-events: none`)", () => {
  const css = readFileSync(new URL("./Sheet.module.css", import.meta.url), "utf8");
  assert.match(css, /\.scrim\[data-closing\],\s*\.scrim\[data-closing\] \.sheet \{ pointer-events: none; \}/);
});
