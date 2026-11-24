import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom, setInputValue } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CrIn } = await import("./fields");

function Figure({ start }: Readonly<{ start: number }>) {
  const [value, setValue] = useState<string | number>(start);
  return <CrIn bad={false} label="First buy amount" onLeave={() => undefined} onValue={setValue} path="first_buy" type="money" value={value} />;
}

test("#1012: a zero figure starts empty under a 0 placeholder, so typing is exactly what shows", async (t) => {
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<Figure start={0} />));
  const input = container.querySelector("input")!;
  assert.equal(input.value, "");
  assert.equal(input.getAttribute("placeholder"), "0");
  await act(async () => { setInputValue(input, "250"); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  assert.equal(input.value, "250", "not 0250");
  await act(async () => root.render(<Figure key="set" start={1_500} />));
  assert.equal(container.querySelector("input")!.value, "1,500", "a figure that is set still shows");
});
