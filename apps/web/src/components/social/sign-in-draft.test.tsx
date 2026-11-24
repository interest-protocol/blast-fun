import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, setInputValue, testEvent } from "../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SIGN_IN_DRAFT_EVENT, saveSignInDraft, takeSignInDraft, useSignInDraft } = await import("./sign-in-draft");
const { SocialViewerProvider, GatedAction, SignInLink } = await import("./SignInGate");
const { authenticatedAction } = await import("./sign-in-gate");

test("OAuth inputs restore once on the same route; stale, corrupt and cross-route records are discarded", () => {
  const storage = dom.window.sessionStorage;
  const fields = { amount: "100.25", why: "My thesis", pay: "SUI" };
  saveSignInDraft(storage, "test", "/create", fields, 1000);
  assert.deepEqual(takeSignInDraft(storage, "test", "/create", 2000), fields);
  assert.equal(takeSignInDraft(storage, "test", "/create", 2000), null);
  for (const [path, now] of [["/other", 2000], ["/create", 1_802_000], ["/create", 999]] as const) {
    saveSignInDraft(storage, "test", "/create", fields, 1000);
    assert.equal(takeSignInDraft(storage, "test", path, now), null);
  }
  for (const raw of ["{", JSON.stringify({ path: "/create", at: 1000, fields: { amount: 12 } })]) {
    storage.setItem("blast:sign-in-draft:test", raw);
    assert.equal(takeSignInDraft(storage, "test", "/create", 2000), null);
  }
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => undefined };
  assert.doesNotThrow(() => saveSignInDraft(blocked, "test", "/create", fields));
  assert.equal(takeSignInDraft(blocked, "test", "/create"), null);
});

test("a mounted form retains edits during session restoration and login, and OAuth restores them after remount", async () => {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  let root = createRoot(container);
  let writes = 0;
  function Form() {
    const [text, setText] = useState("");
    useSignInDraft("test:form", { text }, (saved) => setText(saved.text ?? ""));
    return <><input aria-label="Draft" value={text} onChange={(event) => setText(event.currentTarget.value)} /><GatedAction onAction={() => writes++}>Save</GatedAction><SignInLink /></>;
  }
  const render = async (signedIn: boolean, pending = false) => {
    await act(async () => root.render(<SocialViewerProvider signedIn={signedIn} sessionPending={pending}><Form /></SocialViewerProvider>));
  };
  try {
    await render(false);
    const input = container.querySelector("input")!;
    await act(async () => { setInputValue(input, "Keep this draft"); input.dispatchEvent(testEvent("input")); });
    await render(false, true);
    assert.equal(container.querySelector("input"), input);
    assert.equal(input.value, "Keep this draft");
    assert.equal(container.querySelector("button")!.disabled, true);
    assert.doesNotMatch(container.textContent ?? "", /Sign in/);
    await render(true);
    assert.equal(input.value, "Keep this draft");
    assert.equal(writes, 0, "sign-in never performs an action");
    await render(false);
    await act(async () => dom.document.dispatchEvent(testEvent(SIGN_IN_DRAFT_EVENT)));
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(true);
    assert.equal(container.querySelector("input")!.value, "Keep this draft");
    assert.equal(writes, 0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("protected form actions distinguish restoration, visitor, busy and signed-in validation", () => {
  assert.deepEqual(authenticatedAction({ signedIn: false, sessionPending: true }, "Send", "Sign in", false), { label: "Restoring session…", disabled: true });
  assert.deepEqual(authenticatedAction({ signedIn: false }, "Send", "Sign in", true), { label: "Sign in", disabled: false });
  assert.deepEqual(authenticatedAction({ signedIn: false }, "Send", "Sign in", false, true), { label: "Sign in", disabled: true });
  assert.deepEqual(authenticatedAction({ signedIn: true }, "Send", "Sign in", true), { label: "Send", disabled: true });
  assert.deepEqual(authenticatedAction({ signedIn: true }, "Send", "Sign in", false), { label: "Send", disabled: false });
});
