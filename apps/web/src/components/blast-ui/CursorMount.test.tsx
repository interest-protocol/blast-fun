import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestDom, testEvent } from "../../../test/fixtures/social/test-dom.ts";
import { CursorMount } from "./CursorMount";

const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

async function mount(t: TestContext, eligible = true) {
  const frames = new Map<number, FrameRequestCallback>();
  const images: { src: string; resolve: () => void; reject: () => void }[] = [];
  let nextFrame = 0;
  const OriginalImage = window.Image;
  Object.assign(window, {
    matchMedia: (query: string) => {
      assert.equal(query, "(hover: hover) and (pointer: fine) and (forced-colors: none)");
      return { matches: eligible };
    },
    Image: function () {
      const image = new OriginalImage();
      image.decode = () => new Promise<void>((resolve, reject) => {
        images.push({ src: image.src, resolve, reject: () => reject(new Error("Missing cursor asset")) });
      });
      return image;
    },
  });
  t.mock.method(window, "requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  t.mock.method(window, "cancelAnimationFrame", (id: number) => frames.delete(id));
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<CursorMount />));
  let mounted = true;
  const unmount = async () => {
    if (mounted) await act(async () => root.unmount());
    mounted = false;
  };
  t.after(async () => {
    await unmount();
    container.remove();
    window.Image = OriginalImage;
  });
  return {
    container, images, frames, unmount,
    hidden: () => container.hasAttribute("data-cursor-mounting"),
    paint: () => {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback(0);
      }
    },
  };
}

test("mount hides until both theme arrows decode and the hidden state has painted", async (t) => {
  const page = await mount(t);
  assert.equal(page.hidden(), true);
  assert.deepEqual(page.images.map((image) => image.src.split("/").at(-1)), ["arrow.svg", "arrow-dark.svg"]);
  await act(async () => page.images[0]!.resolve());
  assert.equal(page.frames.size, 0);
  await act(async () => page.images[1]!.resolve());
  page.paint();
  assert.equal(page.hidden(), true);
  page.paint();
  assert.equal(page.hidden(), false);
});

test("failed assets restore the CSS cursors and their native fallbacks", async (t) => {
  const page = await mount(t);
  await act(async () => page.images.forEach((image) => image.reject()));
  page.paint();
  page.paint();
  assert.equal(page.hidden(), false);
});

test("700ms safety timeout restores even when decoding and animation frames stall", async (t) => {
  const page = await mount(t);
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(page.hidden(), false);
  await act(async () => page.images.forEach((image) => image.resolve()));
  assert.equal(page.frames.size, 0);
});

for (const event of ["pointermove", "pointerdown", "blur"]) {
  test(`${event} restores immediately and ignores late image readiness`, async (t) => {
    const page = await mount(t);
    window.dispatchEvent(testEvent(event));
    assert.equal(page.hidden(), false);
    await act(async () => page.images.forEach((image) => image.resolve()));
    assert.equal(page.frames.size, 0);
  });
}

test("unmount cancels the pending paint and restores the root", async (t) => {
  const page = await mount(t);
  await act(async () => page.images.forEach((image) => image.resolve()));
  page.paint();
  await page.unmount();
  assert.equal(page.hidden(), false);
  assert.equal(page.frames.size, 0);
});

test("devices outside the fine-pointer/hover/forced-colors gate retain native cursors", async (t) => {
  const page = await mount(t, false);
  assert.equal(page.hidden(), false);
  assert.equal(page.images.length, 0);
});
