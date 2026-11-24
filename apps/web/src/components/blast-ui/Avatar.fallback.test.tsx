import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, testEvent } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Avatar } = await import("./Avatar");

const PHOTO = "https://pbs.twimg.com/profile_images/1800000000000000000/AbCd_normal.jpg";
const ORIGINAL = PHOTO.replace("_normal", "");

const SIZED = PHOTO.replace("_normal", "_400x400");

test("when the original is missing the 400 px size shows; when both fail the generated circle stays", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<Avatar accountId="kai" avatarUrl={PHOTO} size={89} />));

  const image = () => container.querySelector("img");
  assert.equal(image()?.getAttribute("src"), ORIGINAL);
  assert.equal(image()?.hasAttribute("srcset"), false);

  await act(async () => { image()!.dispatchEvent(testEvent("error", { bubbles: false })); });
  assert.equal(image()?.getAttribute("src"), SIZED);

  // A re-render with the same URL must not restart the walk.
  await act(async () => root.render(<Avatar accountId="kai" avatarUrl={PHOTO} size={89} />));
  assert.equal(image()?.getAttribute("src"), SIZED);

  await act(async () => { image()!.dispatchEvent(testEvent("error", { bubbles: false })); });
  assert.equal(image(), null);
  assert.ok(container.querySelector('[data-avatar="generated"]'));
});

test("a stored Blast picture that fails goes straight to the generated circle", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<Avatar accountId="kai" avatarUrl="https://blob.blast.fun/p.webp" size={40} />));
  await act(async () => { container.querySelector("img")!.dispatchEvent(testEvent("error", { bubbles: false })); });
  assert.equal(container.querySelector("img"), null);
  assert.ok(container.querySelector('[data-avatar="generated"]'));
});
