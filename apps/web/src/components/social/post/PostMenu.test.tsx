import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestDom, recordAnimations, testEvent, type TestElement } from "../../../../test/fixtures/social/test-dom.ts";

/**
 * A post's More menu on base-ui's `Menu` (OA-28 M2b), in the test DOM inside
 * the Blast UI root, where base-ui portals it out of the card. Its motion is
 * the shared one (`BlastMenu.test.tsx`); this is the post's own: the rows,
 * where it opens, and focus back on the dots.
 */

const { document, window } = installTestDom();
const motion = recordAnimations();
const media = { phone: false };
const query = (text: string) => ({ matches: /max-width:\s*760px/.test(text) ? media.phone : false, media: text, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
Object.assign(window, { matchMedia: query });
Object.assign(globalThis, { matchMedia: query });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { PostMenu } = await import("./PostMenu");

const TX = "https://suiscan.xyz/mainnet/tx/9xQ";

async function mount(t: TestContext, phone = false, profilePath?: string): Promise<void> {
  media.phone = phone;
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const card = document.createElement("article");
  container.appendChild(card);
  const root = createRoot(card as unknown as Element);
  await act(async () =>
    root.render(
      <PathnameContext value="/feed">
        <PostMenu profilePath={profilePath} items={["copy-link", "transaction", "report-why"]} postId="p-1" txUrl={TX} whyId="w-1" />
      </PathnameContext>,
    ),
  );
  t.after(async () => {
    await act(async () => root.unmount());
    container.parentNode?.removeChild(container);
    motion.all.length = 0;
  });
}

const dots = () => document.querySelector<HTMLElement>('button[aria-label="More"]') as TestElement;
const menu = () => document.getElementById("post-menu-p-1");

async function frames(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}

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

async function settle(): Promise<void> {
  await act(async () => motion.finishAll());
  await frames();
}

test("§3.7: the More menu opens below the dots, right-aligned, out of the card, with Copy link, the transaction and Report post", async (t) => {
  await mount(t);
  await press(dots());
  const popup = menu()!;
  assert.ok(popup, "it opens");
  assert.equal(popup.getAttribute("aria-label"), "Post");
  assert.equal(dots().getAttribute("aria-expanded"), "true");
  assert.ok(!document.querySelector("article")!.contains(popup), "portalled out of the card (its container query would hold a fixed menu)");
  assert.equal(popup.getAttribute("data-side"), "bottom");
  assert.equal(popup.style.getPropertyValue("--menu-ox"), "calc(100% - 18px)", "it grows from just inside its right edge, under the dots");
  const rows = [...popup.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  assert.deepEqual(
    rows.map((row) => row.textContent),
    ["Copy link to post", "View transaction on Suiscan", "Report post"],
  );
  assert.equal(document.activeElement, rows[0]);
  const tx = rows[1]!;
  assert.equal(tx.localName, "a");
  assert.equal(tx.getAttribute("href"), TX);
  assert.equal(tx.getAttribute("target"), "_blank");
  assert.equal(tx.getAttribute("rel"), "noopener noreferrer");
  // A visitor's report is the sign-in gate's link (§0.3).
  assert.equal(rows[2]!.getAttribute("data-gated"), "sign-in");
  assert.match(rows[2]!.getAttribute("href") ?? "", /^\/sign-in\?next=/);
  assert.match(rows[2]!.className, /danger/);
});

test("§3.7: a choice closes the menu and focus goes back to the dots", async (t) => {
  await mount(t);
  await press(dots());
  await settle();
  await press([...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')][1]!);
  assert.equal(dots().getAttribute("aria-expanded"), "false");
  await settle();
  assert.equal(menu(), null);
  assert.equal(document.activeElement, dots());
});

test("§3.7 (phones): the More menu is the bottom action sheet, rising from the edge", async (t) => {
  await mount(t, true);
  await press(dots());
  const rise = motion.all.filter((animation) => animation.target === menu()).at(-1)!;
  assert.deepEqual(rise.keyframes, [{ transform: "translateY(calc(100% + 16px))" }, { transform: "none" }]);
  assert.deepEqual([rise.timing.duration, rise.timing.easing], [240, "cubic-bezier(.32,.72,0,1)"]);
});

test("a narrow card's More menu keeps the author's profile action reachable", async (t) => {
  await mount(t, true, "/@mirachen");
  await press(dots());
  const profile = menu()!.querySelector<HTMLElement>('[role="menuitem"]')!;
  assert.equal(profile.textContent, "View profile");
  assert.equal(profile.getAttribute("href"), "/@mirachen");
  assert.equal(document.activeElement, profile);
});
