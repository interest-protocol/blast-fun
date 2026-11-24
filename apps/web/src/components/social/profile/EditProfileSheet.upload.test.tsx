import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { QueryClient } from "@tanstack/react-query";

import type { SocialProfileEdit } from "@blast/core/modules/social/contracts/profile-page.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { installTestDom, recordAnimations, setInputValue, testEvent } from "../../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
Object.defineProperty(document, "oninput", { value: null, configurable: true });
const motion = recordAnimations();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { ToastProvider } = await import("#web/components/blast-ui/Toasts.tsx");
const { EditProfileSheet } = await import("./EditProfileSheet");

const OLD_PHOTO = "https://media.blast.fun/avatars/old.webp";
const NEW_PHOTO = "https://media.blast.fun/avatars/new.webp";
const PREVIEW = "data:image/webp;base64,Zml4dHVyZQ==";
const EDIT: SocialProfileEdit = { display_name: "Kai Moreno", picture: "upload", avatar_url: OLD_PHOTO, source_avatar_url: null, upload_available: true };
const PROFILE = "/api/social/me/profile";
const PICTURE = `${PROFILE}/picture`;
type Failure = "none" | "refused" | "network" | "committed_lost" | "committed_unusable";

/** Real editor/query/client orchestration; only HTTP and browser image primitives are simulated. */
async function mount(t: TestContext, { initialOpen = true, autoClose = false, profile = EDIT } = {}) {
  const fixture = {
    current: profile,
    readFailure: false,
    nameFailure: "none" as Failure,
    imageFailure: "none" as Failure,
    writes: [] as string[],
    published: [] as SocialProfileEdit[],
    closes: 0,
  };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (init?.method !== "PUT") {
      if (path.startsWith("/api/social/callsigns/")) return Response.json({ available: true, reason: null });
      assert.equal(path, PROFILE);
      if (fixture.readFailure) throw new TypeError("fixture read unavailable");
      return Response.json(fixture.current);
    }
    fixture.writes.push(path);
    const failure = path === PICTURE ? fixture.imageFailure : fixture.nameFailure;
    if (failure === "network") throw new TypeError("fixture connection lost");
    if (failure === "refused") return Response.json({ error: { code: path === PICTURE ? "picture_upload_unavailable" : "blocked_term" } }, { status: 422 });
    fixture.current = path === PICTURE
      ? { ...fixture.current, avatar_url: NEW_PHOTO }
      : { ...fixture.current, ...JSON.parse(String(init.body)) };
    if (failure === "committed_lost") throw new TypeError("fixture response lost after commit");
    if (failure === "committed_unusable") return Response.json({ incomplete: true });
    return Response.json(fixture.current);
  });
  // jsdom does not implement image decoding/canvas. These fixtures exercise selection
  // and orchestration; real decoding/storage remains covered by the route pipeline.
  for (const [name, value] of Object.entries({
    createImageBitmap: async () => ({ width: 128, height: 128, close() {} }),
    FileReader: class {
      result = PREVIEW;
      onload?: () => void;
      readAsDataURL() { this.onload?.(); }
    },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  t.mock.method(window.HTMLCanvasElement.prototype, "getContext", (() => ({ drawImage() {} })) as unknown as HTMLCanvasElement["getContext"]);
  t.mock.method(window.HTMLCanvasElement.prototype, "toBlob", (callback: BlobCallback) => callback(new Blob(["fixture"], { type: "image/webp" })));

  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container);
  const page = (open: boolean) => (
      <QueryProvider client={queries}><ToastProvider>
        <button data-edit-profile="" onClick={() => root.render(page(true))} type="button">Edit profile</button>
        <EditProfileSheet api={{ getAccessToken: async () => "fixture-owner-token" }} avatarUrl={OLD_PHOTO} callsign="kaimoreno" onClose={() => {
          fixture.closes++;
          if (autoClose) root.render(page(false));
        }} onSaved={(edit) => fixture.published.push(edit)} open={open} />
      </ToastProvider></QueryProvider>
  );
  async function render(open: boolean) {
    await act(async () => root.render(page(open)));
    await act(async () => motion.finishAll());
  }
  t.after(async () => {
    await act(async () => root.unmount());
    queries.clear();
    container.remove();
  });
  await render(initialOpen);
  if (initialOpen) assert.equal(document.querySelector<HTMLInputElement>("#edit-profile-name")!.value, "Kai Moreno");
  return { fixture, queries, render };
}

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const photo = () => sheet().querySelector(".av.s89 img")!.getAttribute("src");
async function clickSave() {
  const save = [...sheet().querySelectorAll("button")].find((button) => button.textContent.trim() === "Save")!;
  assert.equal(save.disabled, false, "the draft remains recoverable");
  await act(async () => save.click());
}
async function typeName(value: string) {
  const name = sheet().querySelector<HTMLInputElement>("#edit-profile-name")!;
  name.type = "text";
  await act(async () => {
    setInputValue(name, value);
    name.dispatchEvent(testEvent("input", { bubbles: true }));
  });
}
async function stagePhoto() {
  await act(async () => {
    const file = sheet().querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(file, "files", { value: [new window.File(["fixture"], "avatar.png", { type: "image/png" })], configurable: true });
    file.dispatchEvent(testEvent("change", { bubbles: true }));
  });
  assert.equal(photo(), PREVIEW);
}
async function stageChanges() {
  await typeName("Kai New");
  await stagePhoto();
}

test("a refused name never uploads the staged photo, and retry saves and reloads both changes", async (t) => {
  const { fixture, render } = await mount(t);
  fixture.nameFailure = "refused";
  await stageChanges();
  await clickSave();
  assert.deepEqual(fixture.writes, [PROFILE]);
  assert.equal(fixture.current.avatar_url, OLD_PHOTO);
  assert.equal(fixture.current.display_name, "Kai Moreno");
  assert.deepEqual(fixture.published, []);
  assert.equal(fixture.closes, 0);
  assert.match(sheet().textContent!, /contains a word that is not allowed/);
  assert.equal(photo(), PREVIEW);
  fixture.nameFailure = "none";
  await clickSave();
  assert.deepEqual(fixture.writes, [PROFILE, PROFILE, PICTURE]);
  assert.equal(fixture.current.avatar_url, NEW_PHOTO);
  assert.equal(fixture.current.display_name, "Kai New");
  assert.equal(fixture.closes, 1);
  await render(false);
  await render(true);
  assert.equal(photo(), NEW_PHOTO);
  assert.equal(sheet().querySelector<HTMLInputElement>("#edit-profile-name")!.value, "Kai New");
});

test("a saved name and refused photo publish partial progress, preserve the old photo, and retain the upload for retry", async (t) => {
  const { fixture, queries } = await mount(t);
  fixture.imageFailure = "refused";
  await stageChanges();
  await clickSave();
  assert.deepEqual(fixture.writes, [PROFILE, PICTURE]);
  assert.equal(fixture.current.avatar_url, OLD_PHOTO);
  assert.equal(fixture.current.display_name, "Kai New");
  assert.deepEqual(fixture.published, [fixture.current]);
  assert.deepEqual(queries.getQueryData(queryKeys.me.profileEdit()), fixture.current);
  assert.equal(fixture.closes, 0);
  assert.match(sheet().textContent!, /Your profile details were saved, but your photo was not saved/);
  assert.doesNotMatch(sheet().textContent!, /Nothing was saved/);
  assert.equal(photo(), PREVIEW, "the draft remains selected, separate from the saved old photo");
  fixture.imageFailure = "none";
  await clickSave();
  assert.deepEqual(fixture.writes, [PROFILE, PICTURE, PICTURE], "an acknowledged name is not submitted again unchanged");
  assert.equal(fixture.current.avatar_url, NEW_PHOTO);
  assert.equal(fixture.published.at(-1)!.avatar_url, NEW_PHOTO);
  assert.equal(fixture.closes, 1);
});

test("a failed name request preserves the photo and cancelling discards the unsaved draft", async (t) => {
  const { fixture, render } = await mount(t);
  fixture.nameFailure = "network";
  await stageChanges();
  await clickSave();
  assert.deepEqual(fixture.writes, [PROFILE]);
  assert.equal(fixture.current.avatar_url, OLD_PHOTO);
  assert.deepEqual(fixture.published, []);
  assert.equal(fixture.closes, 0);
  assert.equal(photo(), PREVIEW);
  assert.match(sheet().textContent!, /Your profile update could not be confirmed/);
  assert.doesNotMatch(sheet().textContent!, /Nothing was saved/);
  await act(async () => sheet().querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  assert.equal(fixture.closes, 1);
  await render(false);
  await render(true);
  assert.equal(photo(), OLD_PHOTO);
  assert.equal(sheet().querySelector<HTMLInputElement>("#edit-profile-name")!.value, "Kai Moreno");
  assert.deepEqual(fixture.writes, [PROFILE], "cancel and reload send no writes");
});

test("an unconfirmed photo response reports the saved name honestly and cancellation retains acknowledged progress", async (t) => {
  const { fixture, queries, render } = await mount(t);
  fixture.imageFailure = "network";
  await stageChanges();
  await clickSave();
  assert.deepEqual(fixture.writes, [PROFILE, PICTURE]);
  assert.equal(fixture.current.avatar_url, OLD_PHOTO);
  assert.equal(fixture.current.display_name, "Kai New");
  assert.deepEqual(fixture.published, [fixture.current]);
  assert.deepEqual(queries.getQueryData(queryKeys.me.profileEdit()), fixture.current);
  assert.match(sheet().textContent!, /Your profile details were saved, but your photo update could not be confirmed/);
  assert.doesNotMatch(sheet().textContent!, /Nothing was saved/);
  assert.equal(fixture.closes, 0);
  await act(async () => sheet().querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  assert.equal(fixture.closes, 1);
  await render(false);
  await render(true);
  assert.equal(photo(), OLD_PHOTO);
  assert.equal(sheet().querySelector<HTMLInputElement>("#edit-profile-name")!.value, "Kai New");
  assert.deepEqual(fixture.writes, [PROFILE, PICTURE], "cancel and reload preserve the saved name without retrying the photo");
});

test("reverting to the original name after partial progress saves that name and the retained photo", async (t) => {
  const { fixture } = await mount(t);
  fixture.imageFailure = "refused";
  await stageChanges();
  await clickSave();
  assert.equal(fixture.current.display_name, "Kai New");
  assert.equal(photo(), PREVIEW);
  await typeName("Kai Moreno");
  fixture.imageFailure = "none";
  await clickSave();
  assert.deepEqual(fixture.writes, [PROFILE, PICTURE, PROFILE, PICTURE]);
  assert.equal(fixture.current.display_name, "Kai Moreno");
  assert.equal(fixture.current.avatar_url, NEW_PHOTO);
  assert.equal(fixture.published.at(-1)!.display_name, "Kai Moreno");
  assert.equal(fixture.closes, 1);
});

for (const [failure, label] of [["committed_lost", "lost"], ["committed_unusable", "unusable"]] as const) {
  test(`a photo-only commit with ${label} response stays unconfirmed and reconciles on reload`, async (t) => {
    const { fixture, queries, render } = await mount(t);
    fixture.imageFailure = failure;
    await stagePhoto();
    await clickSave();
    assert.deepEqual(fixture.writes, [PICTURE]);
    assert.equal(fixture.current.avatar_url, NEW_PHOTO, "the authoritative fixture committed before losing its response");
    assert.equal(fixture.closes, 0);
    assert.deepEqual(fixture.published, [], "an unconfirmed response publishes no successful save");
    assert.equal(photo(), PREVIEW);
    assert.match(sheet().textContent!, /Your photo update could not be confirmed. Check your profile before trying again/);
    assert.doesNotMatch(sheet().textContent!, /Nothing was saved|details were saved/);
    await act(async () => sheet().querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    await render(false);
    await render(true);
    assert.equal(photo(), NEW_PHOTO);
    assert.equal(queries.getQueryData<SocialProfileEdit>(queryKeys.me.profileEdit())!.avatar_url, NEW_PHOTO);
    assert.deepEqual(fixture.writes, [PICTURE], "reload reconciles without another upload");
  });
}

test("changing to another name after partial progress saves the current draft before its retained photo", async (t) => {
  const { fixture } = await mount(t);
  fixture.imageFailure = "refused";
  await stageChanges();
  await clickSave();
  await typeName("Kai Third");
  assert.equal(photo(), PREVIEW);
  fixture.imageFailure = "none";
  await clickSave();
  assert.deepEqual(fixture.writes, [PROFILE, PICTURE, PROFILE, PICTURE]);
  assert.equal(fixture.current.display_name, "Kai Third");
  assert.equal(fixture.current.avatar_url, NEW_PHOTO);
  assert.equal(fixture.closes, 1);
});

test("an explicitly refused photo-only save preserves the old photo and retains its draft for retry", async (t) => {
  const { fixture } = await mount(t);
  fixture.imageFailure = "refused";
  await stagePhoto();
  await clickSave();
  assert.equal(fixture.current.avatar_url, OLD_PHOTO);
  assert.equal(fixture.closes, 0);
  assert.deepEqual(fixture.published, []);
  assert.equal(photo(), PREVIEW);
  assert.match(sheet().textContent!, /Photo uploads are not available right now. Nothing was saved/);
  assert.doesNotMatch(sheet().textContent!, /could not be confirmed/);
  fixture.imageFailure = "none";
  await clickSave();
  assert.deepEqual(fixture.writes, [PICTURE, PICTURE]);
  assert.equal(fixture.current.avatar_url, NEW_PHOTO);
  assert.equal(fixture.closes, 1);
});

test("Escape completes editor dismissal, restores invoker focus, and reopening discards cancelled drafts", async (t) => {
  const { fixture } = await mount(t, { initialOpen: false, autoClose: true });
  const opener = document.querySelector<HTMLButtonElement>("[data-edit-profile]")!;
  opener.focus();
  await act(async () => opener.click());
  await act(async () => motion.finishAll());
  await stageChanges();
  const closingDialog = sheet();
  await act(async () => document.body.dispatchEvent(testEvent("keydown", { key: "Escape" })));
  assert.equal(closingDialog.isConnected, true, "the same Sheet stays mounted until its closing motion finishes");
  assert.equal(closingDialog.parentElement!.hasAttribute("data-closing"), true);
  await act(async () => motion.finishAll());
  assert.equal(fixture.closes, 1);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, opener, "normal shared Sheet close returns focus to its invoker");
  await act(async () => opener.click());
  await act(async () => motion.finishAll());
  assert.equal(photo(), OLD_PHOTO);
  assert.equal(sheet().querySelector<HTMLInputElement>("#edit-profile-name")!.value, "Kai Moreno");
  assert.deepEqual(fixture.writes, []);
});

test("close completion clears cancelled name, callsign and photo drafts even when the reopening read fails", async (t) => {
  const { fixture } = await mount(t, { initialOpen: false, autoClose: true, profile: { ...EDIT, callsign: "kaimoreno", callsign_editable: true } });
  const opener = document.querySelector<HTMLButtonElement>("[data-edit-profile]")!;
  opener.focus();
  await act(async () => opener.click());
  await act(async () => motion.finishAll());
  await stageChanges();
  const callsign = sheet().querySelector<HTMLInputElement>("#blast-callsign")!;
  callsign.type = "text";
  await act(async () => {
    setInputValue(callsign, "cancelled_pilot");
    callsign.dispatchEvent(testEvent("input", { bubbles: true }));
    sheet().querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();
  });
  await act(async () => motion.finishAll());
  assert.equal(document.activeElement, opener);
  fixture.readFailure = true;
  await act(async () => opener.click());
  await act(async () => motion.finishAll());
  assert.equal(sheet().querySelector<HTMLInputElement>("#edit-profile-name")!.value, "Kai Moreno");
  assert.equal(sheet().querySelector<HTMLInputElement>("#blast-callsign")!.value, "kaimoreno");
  assert.equal(photo(), OLD_PHOTO);
  assert.deepEqual(fixture.writes, []);
});

test("saving a callsign with reduced motion returns focus and reopens with the acknowledged callsign", async (t) => {
  window.reducedMotion = true;
  t.after(() => { window.reducedMotion = false; });
  const { fixture } = await mount(t, { initialOpen: false, autoClose: true, profile: { ...EDIT, callsign: "kaimoreno", callsign_editable: true } });
  const opener = document.querySelector<HTMLButtonElement>("[data-edit-profile]")!;
  opener.focus();
  await act(async () => opener.click());
  await act(async () => motion.finishAll());
  const callsign = sheet().querySelector<HTMLInputElement>("#blast-callsign")!;
  callsign.type = "text";
  await act(async () => {
    setInputValue(callsign, "new_pilot");
    callsign.dispatchEvent(testEvent("input", { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 460)));
  await clickSave();
  await act(async () => motion.finishAll());
  assert.equal(fixture.current.callsign, "new_pilot");
  assert.equal(fixture.closes, 1);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, opener);
  await act(async () => opener.click());
  await act(async () => motion.finishAll());
  assert.equal(sheet().querySelector<HTMLInputElement>("#blast-callsign")!.value, "new_pilot");
  assert.deepEqual(fixture.writes, [PROFILE]);
});
