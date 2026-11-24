import assert from "node:assert/strict";
import test from "node:test";
import { installDisclosureMotion } from "./disclosure-motion";
import {
  installTestDom,
  recordAnimations,
  testEvent,
} from "../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const motion = recordAnimations();

test("native disclosures reverse from their live height, close accessibly, and clean up", (t) => {
  document.body.innerHTML =
    '<details><summary>How rewards work <a href="#help">Help</a></summary><div><button>Content</button></div></details>';
  const details = document.querySelector("details")!;
  const summary = details.querySelector("summary")!;
  const content = details.querySelector("div")!;
  let liveHeight: number | undefined;
  t.mock.method(
    details,
    "getBoundingClientRect",
    () => ({ height: liveHeight ?? (details.open ? 240 : 40) }) as DOMRect,
  );
  const cleanup = installDisclosureMotion(document);
  t.after(() => {
    cleanup();
    document.body.replaceChildren();
  });
  const click = () => summary.dispatchEvent(testEvent("click", { detail: 1 }));
  click();
  const enter = motion.all.at(-1)!;
  assert.deepEqual(enter.keyframes, [{ height: "40px" }, { height: "240px" }]);
  assert.equal(details.open, true);
  liveHeight = 110;
  click();
  const exit = motion.all.at(-1)!;
  assert.equal(exit.keyframes[0]!.height, "110px");
  assert.equal(enter.playState, "idle");
  assert.equal(summary.getAttribute("aria-expanded"), "false");
  assert.equal(content.hasAttribute("inert"), true);
  liveHeight = undefined;
  click();
  assert.equal(exit.playState, "idle");
  assert.equal(content.hasAttribute("inert"), false);
  motion.finishAll();
  assert.equal(details.open, true);
  assert.equal(details.hasAttribute("data-disclosure-moving"), false);
  click();
  cleanup();
  assert.equal(details.open, false);
  assert.equal(content.hasAttribute("inert"), false);
  assert.equal(summary.hasAttribute("aria-expanded"), false);
});

test("keyboard, reduced motion, nested controls, and prevented clicks keep native behaviour", (t) => {
  document.body.innerHTML =
    "<details><summary>More <button>Action</button></summary><p>Details</p></details>";
  const summary = document.querySelector("summary")!;
  const cleanup = installDisclosureMotion(document);
  t.after(() => {
    cleanup();
    dom.window.reducedMotion = false;
    document.body.replaceChildren();
  });
  const count = motion.all.length;
  summary.dispatchEvent(testEvent("click", { detail: 0 }));
  dom.window.reducedMotion = true;
  summary.dispatchEvent(testEvent("click", { detail: 1 }));
  dom.window.reducedMotion = false;
  summary
    .querySelector("button")!
    .dispatchEvent(testEvent("click", { detail: 1 }));
  const prevented = testEvent("click", { detail: 1 });
  prevented.preventDefault();
  summary.dispatchEvent(prevented);
  assert.equal(motion.all.length, count);
});
