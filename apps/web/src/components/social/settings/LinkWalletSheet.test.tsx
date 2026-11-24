import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { useState } from "react";

import { installTestDom, recordAnimations, testEvent, type TestElement } from "../../../../test/fixtures/social/test-dom.ts";
import type { LinkOutcome } from "./link-wallet-flow";

/**
 * OA-31: "Link a Sui wallet" closed twice. Escape while the wallet was
 * signing started the close; the wallet then linked within the close's
 * 220 ms and its `close(() => onLinked(outcome))` was dropped, so the page
 * neither toasted nor read `me` again. The gate (version 5, `closeLayer`'s
 * `scrim._closing`): one exit, every callback runs. And the sheet now
 * shares the other sheets' scroll lock instead of restoring whatever it
 * saw when it opened.
 */

const { document } = installTestDom();
const motion = recordAnimations();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Sheet } = await import("#web/components/blast-ui/Sheet.tsx");
const { LinkWalletSheet, useLinkWalletSession } = await import("./LinkWalletSheet");

type Linked = Extract<LinkOutcome, { status: "linked" }>;
const LINKED: Linked = {
  status: "linked",
  name: "Slush",
  wallet: { address: `0x${"88".repeat(32)}`, kind: "slush", linked_at_ms: Date.UTC(2026, 9, 6, 12) },
};

type Calls = Readonly<{ picks: ((outcome: LinkOutcome) => void)[]; closes: number[]; linked: Linked[] }>;

/** The settings page's part (`SettingsScreen`): a button that mounts the sheet, and a shared sheet beside it (Deposit, the tour). */
function Settings({ calls }: Readonly<{ calls: Calls }>) {
  const { picks, closes, linked } = calls;
  const link = useLinkWalletSession();
  const [other, setOther] = useState(false);
  return (
    <>
      <button data-link="" onClick={link.open} type="button">
        Link a wallet
      </button>
      <button data-other="" onClick={() => setOther(true)} type="button">
        Deposit
      </button>
      <Sheet labelledBy="other-title" onRequestClose={() => setOther(false)} open={other}>
        <h2 id="other-title">Deposit USDC</h2>
        <button data-other-close="" onClick={() => setOther(false)} type="button">
          Done
        </button>
      </Sheet>
      {link.session !== null ? (
        <LinkWalletSheet
          key={link.session}
          onClose={() => {
            closes.push(Date.now());
            link.closed(link.session);
          }}
          onLinked={(outcome) => void linked.push(outcome)}
          onPick={() => new Promise<LinkOutcome>((resolve) => void picks.push(resolve))}
        />
      ) : null}
    </>
  );
}

async function mount(t: TestContext): Promise<Calls> {
  const calls: Calls = { picks: [], closes: [], linked: [] };
  // The Blast UI root, where the sheets portal (OA-28 M2: `usePortalContainer`).
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<Settings calls={calls} />));
  t.after(async () => {
    await act(async () => root.unmount());
    container.parentNode?.removeChild(container);
  });
  return calls;
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector) as TestElement | null;
const linkSheet = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((sheet) => sheet.textContent.includes("Link a Sui wallet")) ?? null;

async function click(element: TestElement | null): Promise<void> {
  assert.ok(element !== null, "the control is on the page");
  element.focus();
  await act(async () => element.click());
}

async function escape(): Promise<void> {
  const target = document.activeElement ?? document.body;
  await act(async () => void target.dispatchEvent(testEvent("keydown", { key: "Escape", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })));
}

/** Time passes: every motion reaches its end. */
async function settle(): Promise<void> {
  await act(async () => motion.finishAll());
}

test("OA-31: Escape while signing, then the wallet links mid-close: the sheet leaves once and the page still hears it linked", async (t) => {
  const calls = await mount(t);
  await click($("[data-link]"));
  await settle();
  await click(linkSheet()!.querySelector<HTMLElement>("button.wallet"));
  assert.equal(calls.picks.length, 1, "signing in Slush");
  assert.equal(linkSheet()!.querySelectorAll("button.wallet:disabled").length, 6);
  assert.ok(linkSheet()!.querySelector("button[aria-busy=true]"));

  await escape();
  const sheet = linkSheet()!;
  assert.equal(sheet.getAttribute("aria-modal"), null, "closing, it is no longer a modal layer");
  assert.equal(sheet.parentElement!.getAttribute("data-closing"), "");

  // The wallet links before the close ends: `pick` asks to close again, with the toast.
  await act(async () => calls.picks[0]!(LINKED));
  await settle();
  assert.equal(calls.closes.length, 1, "one exit");
  assert.deepEqual(calls.linked, [LINKED], "and the link reached the page (its toast and the read of `me`)");
  assert.equal(linkSheet(), null);
  assert.equal(document.body.style.overflow, "");
  assert.ok(document.activeElement === $("[data-link]"), "focus is back on Link a wallet");
});

test("OA-31: the link sheet shares the sheets' scroll lock: opened while another sheet closes, it does not leave the page locked", async (t) => {
  await mount(t);
  await click($("[data-other]"));
  await settle();
  assert.equal(document.body.style.overflow, "hidden");
  // The other sheet starts to close and, before its motion ends, the link sheet opens.
  await click($("[data-other-close]"));
  await click($("[data-link]"));
  assert.equal(document.body.style.overflow, "hidden");
  await settle();
  assert.equal(document.body.style.overflow, "hidden", "the link sheet is open");
  await escape();
  await settle();
  assert.equal(linkSheet(), null);
  assert.equal(document.body.style.overflow, "", "nothing is open, so nothing holds the page");
});

test("OA-28 M2: Escape while a wallet signs closes the sheet even though focus fell to <body> (the picked button is disabled)", async (t) => {
  const calls = await mount(t);
  await click($("[data-link]"));
  await settle();
  const picked = linkSheet()!.querySelector<HTMLElement>("button.wallet")!;
  await click(picked);
  assert.equal(picked.getAttribute("disabled"), "", "signing: every wallet button is disabled");
  // A wallet popup can leave focus on the viewport; jsdom cannot blur a disabled control.
  document.documentElement.focus();
  assert.ok(document.activeElement === document.body);
  await escape();
  assert.equal(linkSheet()!.getAttribute("aria-modal"), null, "the sheet heard it and is closing");
  await act(async () => calls.picks[0]!(LINKED));
  await settle();
  assert.equal(linkSheet(), null);
  assert.deepEqual(calls.linked, [LINKED], "the link still reaches the page");
  assert.equal(calls.closes.length, 1);
  assert.ok(document.activeElement === $("[data-link]"), "focus is back on Link a wallet");
});

test("OA-28 M2: the link sheet is the shared sheet: the same box, grabber and pull-down, stacked with the others", async (t) => {
  await mount(t);
  await click($("[data-other]"));
  await settle();
  await click($("[data-link]"));
  const link = linkSheet()!;
  const other = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((sheet) => sheet.textContent.includes("Deposit USDC"))!;
  assert.equal(link.className, other.className, "one `.sheet`");
  assert.ok(Number(link.parentElement!.style.zIndex) > Number(other.parentElement!.style.zIndex), "opened last, drawn on top");
  assert.ok(document.activeElement === link, "focus moves into it");
  await escape();
  await settle();
  assert.equal(linkSheet(), null, "Escape closed the top sheet, the link sheet");
  assert.ok([...document.querySelectorAll<HTMLElement>('[role="dialog"]')].length === 1, "the other stays open");
  await escape();
  await settle();
});

test("OA-31 (open while closing): asked for again while it leaves, a fresh link sheet takes its place and stays; a link the old one was finishing still lands", async (t) => {
  const calls = await mount(t);
  await click($("[data-link]"));
  await settle();
  await click(linkSheet()!.querySelector<HTMLElement>("button.wallet"));
  await escape();
  assert.equal(linkSheet()!.getAttribute("aria-modal"), null, "closing");
  // The row is under the closing scrim, which lets presses through.
  await click($("[data-link]"));
  const fresh = linkSheet()!;
  assert.equal(fresh.getAttribute("aria-modal"), "true", "a fresh sheet, open");
  assert.equal([...document.querySelectorAll<HTMLElement>('[role="dialog"]')].length, 1, "the leaving one is gone at once, as the gate's replaced layer");
  assert.equal(fresh.querySelector<HTMLElement>("button.wallet")!.getAttribute("disabled"), null, "nothing signing in it");
  // The first sheet's wallet links now: its page still hears it.
  await act(async () => calls.picks[0]!(LINKED));
  await settle();
  assert.deepEqual(calls.linked, [LINKED]);
  assert.ok(linkSheet() === fresh, "and the fresh sheet stays");
  assert.equal(document.body.style.overflow, "hidden");
  await escape();
  await settle();
  assert.equal(linkSheet(), null);
  assert.equal(document.body.style.overflow, "");
});
