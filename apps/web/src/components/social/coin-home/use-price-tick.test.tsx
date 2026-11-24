import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, recordAnimations } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const { act, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { usePriceTick } = await import("./use-price-tick");

function Quote({ price, at }: { price: string; at: number }) {
  const figure = useRef<HTMLSpanElement>(null);
  const display = Number(price).toFixed(4);
  usePriceTick(figure, price, display, at);
  return <span ref={figure}>{display}</span>;
}

test("only visible price changes tint, and a burst retargets the same fade", async t => {
  const host = dom.document.createElement("div");
  const root = createRoot(host);
  t.after(async () => { await act(() => root.unmount()); });
  const motion = recordAnimations();
  const show = (price: string, at: number) => act(() => root.render(<Quote price={price} at={at} />));
  await show("0.12342", 10);
  await show("0.12344", 11);
  assert.equal(motion.all.length, 0);
  await show("0.12351", 12);
  assert.equal(host.textContent, "0.1235");
  const direction = () => host.querySelector("span")!.style.getPropertyValue("--home-price-direction");
  assert.equal(direction(), "var(--up)");
  assert.equal(motion.all[0]!.timing.duration, 450);
  await show("0.12339", 13);
  assert.equal(host.textContent, "0.1234");
  assert.equal(direction(), "var(--down)");
  await show("0.12340", 14);
  assert.equal(motion.all.length, 1);
  dom.window.reducedMotion = true;
  await show("0.12401", 15);
  assert.equal(motion.all[0]!.playState, "idle");
  assert.equal(motion.all.length, 1);
});
