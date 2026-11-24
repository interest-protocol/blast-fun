import assert from "node:assert/strict";
import test from "node:test";
import {
  installTestDom,
  testEvent,
} from "../../../../test/fixtures/social/test-dom.ts";
import type { GuestDraftRestore } from "./guest-draft-storage.ts";
import { blankDraft } from "@blast/core/modules/social/create/model.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { GuestDraftRecovery } = await import("./GuestDraftRecovery.tsx");

test("recovery exports exact retained copies, labels canonical import and exposes retry without deleting anything", async () => {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const exports: [string, string][] = [];
  let retries = 0;
  const raw = "  { private retained bytes\n";
  try {
    await act(async () =>
      root.render(
        <GuestDraftRecovery
          restored={{
            status: "recovery_required",
            snapshot: { retainedRaw: raw, canonicalRaw: null },
            reason: "retained",
          }}
          busy={false}
          error={null}
          unsavedDraft={false}
          separateDraft={false}
          onExport={(value, name) => exports.push([value, name])}
          onImport={async () => {}}
          onUse={() => assert.fail("not recovered")}
          onRetry={() => retries++}
        />,
      ),
    );
    const exportButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Export retained draft",
    )!;
    await act(async () => exportButton.click());
    assert.deepEqual(exports, [[raw, "blast-retained-draft.json"]]);
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]')!;
    assert.equal(container.querySelector("label")!.htmlFor, input.id);
    assert.equal(input.accept, "application/json,.json");
    assert.doesNotMatch(container.textContent!, /private retained bytes/);
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Check browser storage again")!
        .click(),
    );
    assert.equal(retries, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a recovered file needs explicit adoption and protects unsaved account edits; pending and failure feedback are accessible", async () => {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  let uses = 0;
  const restored = {
    status: "canonical",
    snapshot: { retainedRaw: "source", canonicalRaw: "canonical" },
    draft: { ...blankDraft(), name: "Recovered presale" },
    recoveredFrom: "source-hash",
  } as const;
  const render = (
    busy: boolean,
    unsavedDraft: boolean,
    error: string | null,
  ) =>
    act(async () =>
      root.render(
        <GuestDraftRecovery
          restored={restored}
          busy={busy}
          error={error}
          unsavedDraft={unsavedDraft}
          separateDraft
          onExport={() => {}}
          onImport={async () => {}}
          onUse={() => uses++}
          onRetry={() => {}}
        />,
      ),
    );
  try {
    await render(false, true, null);
    const button = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent === "Use as a separate draft",
      )!;
    assert.equal(button().disabled, true);
    await act(async () => button().click());
    assert.equal(uses, 0);
    await render(true, false, null);
    assert.ok(
      container.querySelector('[aria-label="Checking recovered draft"]'),
    );
    assert.equal(button().disabled, true);
    await render(
      false,
      false,
      "The file could not be saved. The retained copy is unchanged.",
    );
    assert.match(
      container.querySelector('[role="alert"]')!.textContent!,
      /retained copy is unchanged/,
    );
    assert.equal(
      container.querySelector('input[type="file"]'),
      null,
      "another canonical copy cannot be overwritten through import",
    );
    await act(async () => button().dispatchEvent(testEvent("click")));
    assert.equal(uses, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});


test("unavailable, conflicting and already saved browser copies offer a non-destructive separate draft path", async () => {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const states: GuestDraftRestore[] = [
    { status: "storage_error" },
    ...(["retained", "invalid", "conflict", "changed"] as const).map((reason) => ({ status: "recovery_required" as const, reason, snapshot: { retainedRaw: "opaque source", canonicalRaw: reason === "retained" ? null : "opaque current" } })),
    { status: "acknowledged", snapshot: { retainedRaw: null, canonicalRaw: "saved copy" } },
  ];
  let separate = 0;
  try {
    for (const restored of states) {
      await act(async () => root.render(<GuestDraftRecovery restored={restored} busy={false} error={null} unsavedDraft={false} separateDraft={false} onExport={() => {}} onImport={async () => {}} onUse={() => assert.fail("unresolved copy cannot be adopted")} onRetry={() => {}} onContinueSeparate={() => separate++} />));
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Continue with a separate draft");
      assert.ok(button, `separate draft option for ${restored.status}`);
      assert.ok(container.querySelector("h1"), "replacement page keeps a main heading");
      assert.match(container.textContent!, /keeps.*browser copies|browser copies.*kept/i);
      assert.doesNotMatch(container.textContent!, /offline recovery tool|repository|CLI/);
      await act(async () => button.click());
    }
    assert.equal(separate, states.length);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("active publishing or uploads disables adoption with an associated explanation while export remains available", async () => {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<GuestDraftRecovery restored={{ status: "canonical", snapshot: { retainedRaw: "raw", canonicalRaw: "canonical" }, draft: blankDraft(), recoveredFrom: "source" }} busy={false} activeOperation error={null} unsavedDraft={false} separateDraft={false} onExport={() => {}} onImport={async () => {}} onUse={() => assert.fail("active operation")} onRetry={() => {}} />));
    const use = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Use recovered draft")!;
    assert.equal(use.disabled, true);
    const description = use.getAttribute("aria-describedby");
    assert.ok(description);
    assert.match(dom.document.getElementById(description)!.textContent!, /Finish publishing and uploads/);
    assert.equal([...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Export retained draft")!.disabled, false);
    assert.equal(container.querySelector('[aria-label="Checking recovered draft"]'), null);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("file import moves focus to the recovery heading and announces successful recovery", async () => {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const render = (restored: GuestDraftRestore) => root.render(<GuestDraftRecovery restored={restored} busy={false} error={null} unsavedDraft={false} separateDraft={false} onExport={() => {}} onImport={async () => { render({ status: "canonical", snapshot: { retainedRaw: "raw", canonicalRaw: "canonical" }, draft: blankDraft(), recoveredFrom: "receipt" }); }} onUse={() => {}} onRetry={() => {}} />);
  try {
    await act(async () => render({ status: "recovery_required", reason: "retained", snapshot: { retainedRaw: "raw", canonicalRaw: null } }));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    input.focus();
    Object.defineProperty(input, "files", { value: [new dom.window.File(["{}"], "recovered.json")] });
    await act(async () => input.dispatchEvent(testEvent("change")));
    assert.equal(dom.document.activeElement, container.querySelector("h1"));
    assert.match(container.querySelector('[role="status"]')!.textContent!, /recovered copy/i);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
