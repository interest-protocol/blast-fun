import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test, { type TestContext } from "node:test";
import { toast as sonner } from "sonner";

import type { SocialProfileEdit } from "@blast/core/modules/social/contracts/profile-page.ts";

import { installTestDom, setInputValue, recordAnimations, testEvent, type TestElement } from "../../../../test/fixtures/social/test-dom.ts";
import type { ProfileEditDraft } from "./EditProfileSheet";

/**
 * OA-44 (2026-10-07): the Edit profile sheet takes the gate's layout and copy
 * (`design/blast-trading-home-oa43.html` `openEditProfile`, sha256 aa760f6f…):
 * the lead, the 89px avatar with its upload badge ("Change picture"), the
 * "Profile picture" block, no character counter, the hint "Your handle stays
 * @<handle>.". OA-13's "Use X photo" and
 * "Remove photo" stay, as quiet small buttons in the "Profile picture" block,
 * and still stage their change for the save.
 */

const { document } = installTestDom();
const motion = recordAnimations();
// React decides at load whether the browser has `input` events (`'oninput' in document`); this one does.
Object.defineProperty(document, "oninput", { value: null, writable: true, configurable: true });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ToastProvider } = await import("#web/components/blast-ui/Toasts.tsx");
const { EditSheetView } = await import("./EditProfileSheet");

const X_PHOTO = "https://pbs.twimg.com/profile_images/kai.jpg";
const UPLOADED = "https://media.blast.fun/avatars/kai.webp";
const EDIT: SocialProfileEdit = { display_name: "Kai Moreno", picture: "upload", avatar_url: UPLOADED, source_avatar_url: X_PHOTO, upload_available: true };

type Calls = { saves: ProfileEditDraft[]; closes: number };

async function mount(t: TestContext, initial: SocialProfileEdit | null = EDIT, avatarUrl: string | null = null, onSave?: (draft: ProfileEditDraft) => Promise<string | null>, loadError?: string, onReopen?: () => void): Promise<Calls> {
  const calls: Calls = { saves: [], closes: 0 };
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <ToastProvider>
        <EditSheetView
          avatarUrl={avatarUrl}
          callsign="kaimoreno"
          initial={initial}
          loadError={loadError}
          onClose={() => void calls.closes++}
          onReopen={onReopen}
          onSave={async (draft) => {
            calls.saves.push(draft);
            return onSave ? onSave(draft) : null;
          }}
          open
        />
      </ToastProvider>,
    ),
  );
  await act(async () => motion.finishAll());
  t.after(async () => {
    await act(async () => root.unmount());
    container.parentNode?.removeChild(container);
  });
  return calls;
}

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]') as TestElement;
const buttonNamed = (name: string) => [...sheet().querySelectorAll("button")].find((b) => b.textContent.trim() === name) ?? null;
const save = () => buttonNamed("Save");

async function click(element: TestElement | null): Promise<void> {
  assert.ok(element !== null, "the control is on the sheet");
  await act(async () => element.click());
}

async function typeName(value: string): Promise<void> {
  const input = sheet().querySelector<HTMLElement>("#edit-profile-name") as TestElement & { value: string; type?: string };
  input.type = "text";
  await act(async () => {
    setInputValue(input, value);
    input.dispatchEvent(testEvent("input", { bubbles: true }));
  });
}

test("a rejected save keeps the draft open, reports the uncertain result, and permits another save", async (t) => {
  let attempts = 0;
  const calls = await mount(t, EDIT, null, async () => {
    if (++attempts === 1) throw new Error("connection lost");
    return null;
  });
  await typeName("Kai New");
  await click(save());
  assert.equal(calls.closes, 0);
  assert.ok(sheet().textContent.includes("The update could not be confirmed. Check your profile and try again."));
  assert.equal(save()!.hasAttribute("disabled"), false);
  assert.equal((sheet().querySelector("#edit-profile-name") as TestElement & { value: string }).value, "Kai New");
  await click(save());
  assert.equal(calls.closes, 1);
  assert.equal(calls.saves.length, 2);
  assert.deepEqual(calls.saves[0], calls.saves[1], "the failed attempt retains the staged changes");
});

test("an instant save closes the sheet before the server answers; a refusal reopens it with the draft kept", async (t) => {
  const answer = Promise.withResolvers<string | null>();
  let reopened = 0;
  const calls = await mount(t, EDIT, null, () => answer.promise, undefined, () => void reopened++);
  await typeName("Kai New");
  await click(save());
  assert.equal(calls.closes, 1, "closed at once, before the server answered");
  assert.equal(reopened, 0);
  await act(async () => {
    answer.resolve("The update could not be confirmed. Check your profile and try again.");
    await answer.promise;
  });
  assert.equal(reopened, 1, "a refusal reopens the sheet");
  assert.equal((sheet().querySelector("#edit-profile-name") as TestElement & { value: string }).value, "Kai New");
  assert.equal(calls.saves.length, 1);
});

test("OA-44: the gate's copy and structure: 89px avatar with the upload badge, the Profile picture block, the handle hint, no counter", async (t) => {
  await mount(t);
  const s = sheet();
  assert.equal(s.querySelector<HTMLElement>("h2")!.textContent, "Edit profile");
  assert.equal(s.querySelector(".lead"), null);
  assert.doesNotMatch(s.textContent!, /How people see you on Blast\./);

  const label = s.querySelector<HTMLElement>('label[title="Change picture"]')!;
  assert.ok(label, "the avatar is the upload control");
  assert.equal(label.getAttribute("tabindex"), "0");
  assert.ok(label.querySelector<HTMLElement>(".av.s89"), "the 89px avatar");
  const file = label.querySelector("input") as TestElement & { type?: string };
  assert.equal(file.type, "file");
  assert.equal(file.getAttribute("accept"), "image/png,image/jpeg,image/webp");
  assert.ok(file.hasAttribute("hidden"));
  assert.ok(label.querySelector<HTMLElement>('span[aria-hidden="true"] svg'), "the upload badge");
  assert.equal(label.querySelector<HTMLElement>(".sr")!.textContent, "Change picture");

  assert.equal(s.querySelector("b")!.textContent, "Profile picture");
  assert.ok(s.textContent.includes("PNG, JPG or WebP, up to 2 MB."));
  assert.equal(buttonNamed("Upload photo"), null, "the badge replaces the old Upload photo button");

  assert.equal(s.querySelector<HTMLElement>("#edit-profile-name-msg")!.textContent, "Your handle stays @kaimoreno.");
  assert.doesNotMatch(s.textContent, /\d+\/32/, "no character counter");
  assert.equal(save()!.hasAttribute("disabled"), true, "nothing changed yet");
});

test("OA-44: the avatar opens the file picker from the keyboard, as the gate's `label.ep-av` (Enter and Space)", async (t) => {
  await mount(t);
  const label = sheet().querySelector<HTMLElement>('label[title="Change picture"]')!;
  const file = label.querySelector("input")!;
  let picks = 0;
  file.addEventListener("click", () => void picks++);
  for (const key of ["Enter", " ", "a"]) await act(async () => void label.dispatchEvent(testEvent("keydown", { key, bubbles: true })));
  assert.equal(picks, 2);
});

test("OA-44: an empty name says the gate's line and cannot be saved; a new name can", async (t) => {
  const calls = await mount(t);
  await typeName("   ");
  const msg = sheet().querySelector<HTMLElement>("#edit-profile-name-msg")!;
  assert.equal(msg.textContent, "Your name can’t be empty.");
  assert.equal(msg.getAttribute("data-tone"), "bad");
  assert.equal(save()!.hasAttribute("disabled"), true);

  await typeName("Kai M");
  assert.equal(sheet().querySelector<HTMLElement>("#edit-profile-name-msg")!.textContent, "Your handle stays @kaimoreno.");
  const toastCount = sonner.getHistory().length;
  await click(save());
  await act(async () => motion.finishAll());
  assert.deepEqual(calls.saves, [{ name: "Kai M", picture: { kind: "keep" } }]);
  assert.equal(calls.closes, 1);
  assert.equal(sonner.getHistory().length, toastCount, "the updated profile needs no success toast");
});

test("the bio field explains its limit and an empty draft clears a saved bio", async (t) => {
  const calls = await mount(t, { ...EDIT, bio: "Building on Sui" });
  const bio = sheet().querySelector<HTMLTextAreaElement>("#edit-profile-bio")!;
  assert.equal(bio.value, "Building on Sui");

  await act(async () => {
    setInputValue(bio, "😀".repeat(161));
    bio.dispatchEvent(testEvent("input", { bubbles: true }));
  });
  assert.equal(bio.getAttribute("aria-invalid"), "true");
  assert.equal(save()!.hasAttribute("disabled"), true);
  const hintId = save()!.getAttribute("aria-describedby");
  assert.equal(sheet().querySelector(`#${hintId} [aria-live="polite"]`)?.textContent, "Use at most 160 characters.");

  await act(async () => {
    setInputValue(bio, "");
    bio.dispatchEvent(testEvent("input", { bubbles: true }));
  });
  assert.equal(save()!.hasAttribute("disabled"), false);
  await click(save());
  assert.deepEqual(calls.saves, [{ name: null, picture: { kind: "keep" }, bio: "" }]);
});

test("Enter that confirms an IME character, in Safari too, does not save the name; a plain Enter does", async (t) => {
  const calls = await mount(t);
  await typeName("かい");
  const input = sheet().querySelector<HTMLElement>("#edit-profile-name")!;
  await act(async () => void input.dispatchEvent(testEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
  assert.deepEqual(calls.saves, [], "the IME's Enter confirms the character");
  await act(async () => void input.dispatchEvent(testEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true })));
  assert.deepEqual(calls.saves, [], "Safari reports isComposing false but keyCode 229");
  await act(async () => void input.dispatchEvent(testEvent("keydown", { key: "Enter", bubbles: true })));
  assert.deepEqual(calls.saves, [{ name: "かい", picture: { kind: "keep" } }]);
});

test("OA-13 kept by OA-44: Remove photo stages the generated avatar and saves it", async (t) => {
  const calls = await mount(t);
  assert.ok(buttonNamed("Use X photo"), "an uploaded picture can switch back to the X photo");
  assert.ok(buttonNamed("Remove photo"));
  assert.equal(buttonNamed("Remove photo")!.className, "btn btn-quiet btn-sm", "the gate's quiet small button");

  await click(buttonNamed("Remove photo"));
  assert.equal(buttonNamed("Remove photo"), null, "nothing left to remove");
  assert.ok(buttonNamed("Use X photo"));
  assert.equal(sheet().querySelector<HTMLElement>(".av.s89 img"), null, "the generated avatar, not a photo");
  assert.equal(save()!.hasAttribute("disabled"), false);

  await click(save());
  await act(async () => motion.finishAll());
  assert.deepEqual(calls.saves, [{ name: null, picture: { kind: "none" } }]);
  assert.equal(calls.closes, 1);
});

test("OA-13 kept by OA-44: Use X photo stages the account's X picture and saves it", async (t) => {
  const calls = await mount(t);
  await click(buttonNamed("Use X photo"));
  assert.equal(buttonNamed("Use X photo"), null, "already the X photo");
  assert.ok(buttonNamed("Remove photo"));
  await click(save());
  await act(async () => motion.finishAll());
  assert.deepEqual(calls.saves, [{ name: null, picture: { kind: "source" } }]);
});

test("OA-44: a wallet-only account has no X photo; without a picture store the avatar is no upload control", async (t) => {
  await mount(t, { display_name: "Deni", picture: "none", avatar_url: null, source_avatar_url: null, upload_available: false });
  assert.equal(buttonNamed("Use X photo"), null);
  assert.equal(buttonNamed("Remove photo"), null, "nothing to remove");
  assert.equal(sheet().querySelector<HTMLElement>('label[title="Change picture"]'), null);
  assert.equal([...sheet().querySelectorAll("input")].length, 1, "the name field only, no file field");
  assert.ok(sheet().textContent.includes("Photo uploads are not available right now."));
});

test("while its read loads, the sheet draws the page's avatar, not the generated one", async (t) => {
  await mount(t, null, X_PHOTO);
  assert.equal(sheet().querySelector(".av.s89 img")!.getAttribute("src"), X_PHOTO);
  assert.ok(sheet().querySelector("#edit-profile-name")!.hasAttribute("disabled"));
  assert.ok(save()!.hasAttribute("disabled"));
});

test("a loaded profile with its photo removed overrides the page's old avatar", async (t) => {
  await mount(t, { ...EDIT, picture: "none", avatar_url: null }, X_PHOTO);
  assert.equal(sheet().querySelector(".av.s89 img"), null);
});

test("OA-44: the sheet is the gate's `.sheet.trade` (460px, 17px gaps) and draws no counter", () => {
  const css = readFileSync(new URL("./Profile.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.epSheet\.epSheet \{ width: min\(460px, 100%\); gap: 17px; \}/);
  assert.match(css, /\.epBadge \{ position: absolute; right: 1px; bottom: 1px; width: 28px; height: 28px;/);
  assert.match(css, /\.epBadge svg \{ width: 15px; height: 15px; \}/);
  assert.doesNotMatch(css, /\.count \{/);
});


test("social accounts can edit their saved callsign", async (t) => {
  const calls = await mount(t, { ...EDIT, callsign: "kaimoreno", callsign_editable: true });
  const field = sheet().querySelector("#blast-callsign") as TestElement & { type: string };
  assert.ok(field);
  field.type = "text";
  t.mock.method(globalThis, "fetch", async () => Response.json({ available: true, reason: null }));
  await act(async () => {
    setInputValue(field, "new_pilot");
    field.dispatchEvent(testEvent("input", { bubbles: true }));
  });
  assert.equal(save()!.hasAttribute("disabled"), true);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 460)));
  await click(save());
  assert.deepEqual(calls.saves, [{ name: null, picture: { kind: "keep" }, callsign: "new_pilot" }]);
});


test("a failed profile read shows its diagnostic without enabling a save", async (t) => {
  await mount(t, null, null, undefined, "Your profile could not load. Close this and try again. Code: service_unavailable. Reference: profile-read-213.");
  assert.match(sheet().textContent, /Code: service_unavailable/);
  assert.match(sheet().textContent, /Reference: profile-read-213/);
  assert.equal(save()!.hasAttribute("disabled"), true);
});

test("cancelling the photo picker or dismissing a staged picture preserves the current photo without saving", async (t) => {
  const calls = await mount(t);
  const input = sheet().querySelector('input[type="file"]')!;
  await act(async () => input.dispatchEvent(testEvent("change", { bubbles: true })));
  assert.equal(sheet().querySelector(".av.s89 img")!.getAttribute("src"), UPLOADED);
  assert.equal(save()!.hasAttribute("disabled"), true);
  await click(buttonNamed("Use X photo"));
  await click(sheet().querySelector('[aria-label="Close"]'));
  assert.equal(calls.closes, 1);
  assert.deepEqual(calls.saves, []);
});
