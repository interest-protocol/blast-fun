import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WorkspaceSaveStatus } = await import("./WorkspaceSaveStatus");
const { WorkspaceStatusTarget } = await import("./frame-targets");

test("saving is quiet (audit 03): a quick save says nothing, a slow one is announced without a spinner, a failure stays", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const host = document.createElement("div");
  const target = document.createElement("div");
  document.body.append(host, target);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); target.remove(); });
  const show = async (state: "local" | "saving" | "synced" | "error") => {
    await act(async () => root.render(<WorkspaceStatusTarget value={target}><WorkspaceSaveStatus state={state} retry={() => undefined} /></WorkspaceStatusTarget>));
  };
  await show("synced");
  assert.equal(target.textContent, "", "a saved workspace stays quiet");
  const region = target.querySelector('[role="status"]');
  assert.ok(region, "the status region is mounted before any save");
  // An ordinary view change: pending, then saved within 1.5s. Nothing appears in the header.
  await show("local");
  assert.equal(target.textContent, "");
  await show("saving");
  await act(async () => t.mock.timers.tick(1000));
  assert.equal(target.textContent, "", "a quick save announces nothing");
  await show("synced");
  assert.equal(target.textContent, "", "no Saved flash after a save");
  assert.equal(target.querySelector('[role="status"]'), region, "the live region stays mounted");
  // A slow save: after 1.5s it is announced to assistive technology, with nothing drawn (owner, 2026-10-29: no spinners in the bar).
  await show("saving");
  await act(async () => t.mock.timers.tick(1501));
  assert.equal(region.textContent, "Saving workspace", "a save still pending after 1.5s is announced");
  assert.equal(region.className, "sr", "the announcement is visually hidden");
  assert.equal(target.querySelector('[role="progressbar"], svg'), null, "no spinner is drawn");
  await show("synced");
  assert.equal(target.textContent, "");
  // A failure stays, with its recovery, until the state changes.
  await show("error");
  assert.match(target.textContent!, /Save error/);
  await act(async () => t.mock.timers.tick(10000));
  assert.match(target.textContent!, /Retry/);
  await show("synced");
  assert.equal(target.textContent, "");
});
