import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom, recordAnimations } from "../../../test/fixtures/social/test-dom.ts";
import { closeSheetMotion, swapSheetMotion } from "./sheet-motion";

const { document } = installTestDom();

test("coin steps use a small content transition, and change immediately from the keyboard or reduced motion", () => {
  const motion = recordAnimations();
  const container = document.createElement("div");
  container.setAttribute("data-coin-flow", "");
  let changes = 0;
  document.documentElement.dataset.blastInput = "pointer";
  swapSheetMotion(container, () => { changes += 1; }, { reduce: false });
  assert.equal(changes, 0);
  assert.equal(motion.all[0]?.keyframes.at(-1)?.transform, "translateX(-4px)");
  motion.finishAll();
  assert.equal(changes, 1);
  assert.equal(motion.all[1]?.keyframes[0]?.transform, "translateX(4px)");
  assert.equal(Number(motion.all[0]?.timing.duration) + Number(motion.all[1]?.timing.duration), 180);
  for (const reduce of [false, true]) {
    document.documentElement.dataset.blastInput = reduce ? "pointer" : "keyboard";
    swapSheetMotion(container, () => { changes += 1; }, { reduce });
    assert.equal(motion.all.length, 2);
  }
  assert.equal(changes, 3);
  delete document.documentElement.dataset.blastInput;
});

test("interrupting a coin step commits only the latest selection", () => {
  for (const reduce of [false, true]) {
    const motion = recordAnimations();
    const container = document.body.appendChild(document.createElement("div"));
    container.setAttribute("data-coin-flow", "");
    const changes: string[] = [];
    swapSheetMotion(container, () => changes.push("earlier"), { reduce: false });
    container.style.opacity = "0.45";
    container.style.transform = "translateX(-2px)";
    swapSheetMotion(container, () => changes.push("latest"), { reduce });
    if (!reduce) assert.deepEqual(motion.all[1]?.keyframes[0], { opacity: 0.45, transform: "translateX(-2px)" });
    motion.finishAll();
    assert.deepEqual(changes, ["latest"]);
    container.remove();
  }
});


test("interrupting a desktop entrance dismisses from the visible position and opacity along the entrance path", () => {
  const motion = recordAnimations();
  const scrim = document.createElement("div");
  const sheet = document.createElement("div");
  closeSheetMotion(scrim, sheet, { phone: false, reduce: false, read: (element) => element === sheet
    ? { transform: "matrix(1,0,0,1,0,3)", opacity: "0.45" } : { opacity: "0.6" } });
  assert.deepEqual(motion.all[1]?.keyframes, [{ opacity: 0.45, transform: "translateY(3px)" }, { opacity: 0, transform: "translateY(6px)" }]);
  assert.deepEqual(motion.all[0]?.keyframes, [{ opacity: 0.6 }, { opacity: 0 }]);
});
