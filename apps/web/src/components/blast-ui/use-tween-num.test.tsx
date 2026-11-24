import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

/**
 * Money figures update in place, instantly (owner, 2026-10-28). `TweenNum` keeps its callers' props and draws the
 * spot's own formatter for the read's value on every render: no count, no frame loop.
 */

const dom = installTestDom();

let frames = 0;
for (const target of [globalThis, dom.window] as Record<string, unknown>[]) {
  Object.defineProperty(target, "requestAnimationFrame", { value: () => ++frames, configurable: true, writable: true });
}

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { usd } = await import("@blast/core/lib/format.ts");
const { TWEEN_NUM_S, wholeCount } = await import("./tween-num");
const { TweenNum, CoinTweenNum } = await import("./use-tween-num");

/** The gold card's figure: the gate's `money` (cents shown), as `[data-bal]` is drawn. */
function Figure({ value, hidden = false, reveal = false, duration }: Readonly<{ value: number | null; hidden?: boolean; reveal?: boolean; duration?: number }>) {
  return <b>{value === null ? "—" : <TweenNum countUpOnReveal={reveal} duration={duration} format={(shown) => hidden ? "$••••••" : usd(shown, 2)} hidden={hidden} value={value} />}</b>;
}

function mount() {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  return {
    text: () => host.textContent ?? "",
    render: (node: React.ReactNode) => act(async () => root.render(node)),
    unmount: () => act(async () => root.unmount()),
  };
}

test("a new total shows at once, in its formatter's text, whatever duration a caller names", async () => {
  const view = mount();
  const before = frames;
  await view.render(<Figure value={1000} />);
  assert.equal(view.text(), "$1,000.00");
  for (const duration of [undefined, TWEEN_NUM_S.live, TWEEN_NUM_S.lastHour]) {
    await view.render(<Figure duration={duration} value={2000} />);
    assert.equal(view.text(), "$2,000.00", "never the old total first");
    await view.render(<Figure duration={duration} value={1000} />);
    assert.equal(view.text(), "$1,000.00");
  }
  assert.equal(frames, before, "no frame is asked for");
  await view.unmount();
});

test("masking shows the dots at once; unmasking shows the figure at once, never counting up from zero", async () => {
  const view = mount();
  await view.render(<Figure reveal value={4760} />);
  await view.render(<Figure hidden reveal value={4760} />);
  assert.equal(view.text(), "$••••••");
  await view.render(<Figure reveal value={4760} />);
  assert.equal(view.text(), "$4,760.00");
  await view.unmount();
});

test("a figure that was unknown shows its first value at once", async () => {
  const view = mount();
  await view.render(<Figure value={null} />);
  assert.equal(view.text(), "—");
  await view.render(<Figure value={812.4} />);
  assert.equal(view.text(), "$812.40");
  await view.unmount();
});

test("`TweenNum` on the server is its formatter's text in an unstyled span", () => {
  const html = renderToString(
    <b className="num">
      <TweenNum format={usd} value={184_221} />
    </b>,
  );
  assert.equal(html, '<b class="num"><span>$184,221</span></b>');
  assert.equal(renderToString(<TweenNum format={wholeCount} value={2_216} />), "<span>2,216</span>");
  assert.equal(wholeCount(1_011.5), "1,012");
});

test("coin figures show the read's exact atoms even when the numeric value rounds", async () => {
  const view = mount();
  const count = { value: 9007199254740992, atoms: "9007199254740993", quote: { symbol: "SUI", decimals: 0 } };
  await view.render(<CoinTweenNum count={{ ...count, value: 1, atoms: "1" }} />);
  await view.render(<CoinTweenNum count={count} />);
  assert.equal(view.text(), "9,007,199,254,740,993 SUI");
  await view.unmount();
});
