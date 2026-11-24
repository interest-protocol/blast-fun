import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const { act, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useZoomHint } = await import("./zoom-hint.ts");

test("the zoom hint hides on time through live re-renders and shows once per session (audit F41)", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let hint!: ReturnType<typeof useZoomHint>;
  // Like the chart, which tears down and rebuilds its listeners on every live candle.
  function Chart({ candle }: { candle: number }) {
    hint = useZoomHint();
    useEffect(() => () => {}, [candle]);
    return <span data-visible={hint.visible || undefined} />;
  }
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const visible = () => container.querySelector("[data-visible]") !== null;
  try {
    await act(async () => root.render(<Chart candle={0} />));
    await act(async () => hint.show());
    assert.ok(visible());
    for (const candle of [1, 2, 3]) {
      await act(async () => root.render(<Chart candle={candle} />));
      await act(async () => t.mock.timers.tick(500));
    }
    assert.ok(visible(), "still within its 1.6 s");
    await act(async () => t.mock.timers.tick(100));
    assert.equal(visible(), false, "a live candle cannot strand the hint");
    await act(async () => hint.show());
    assert.equal(visible(), false, "once per session");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
