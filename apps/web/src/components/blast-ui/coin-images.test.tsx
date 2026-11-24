import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

test("an artwork download failure cannot change another root's initial hydration markup", async (t) => {
  const { document } = installTestDom();
  const { act } = await import("react");
  const { createRoot, hydrateRoot } = await import("react-dom/client");
  const { renderToString } = await import("react-dom/server");
  const { useCoinImages } = await import("./coin-images.ts");
  const url = "/missing-fixture-coin.png";
  function ArtworkState() {
    const { failed, fail } = useCoinImages();
    return <button onClick={() => fail(url)}>{failed(url) ? "missing" : "artwork"}</button>;
  }

  const first = document.body.appendChild(document.createElement("div"));
  const second = document.body.appendChild(document.createElement("div"));
  second.innerHTML = renderToString(<ArtworkState />);
  const owner = createRoot(first);
  await act(async () => owner.render(<ArtworkState />));
  await act(async () => first.querySelector("button")!.click());
  assert.equal(first.textContent, "missing");

  const errors: unknown[] = [];
  const hydrated = hydrateRoot(second, <ArtworkState />, { onRecoverableError: (error) => errors.push(error) });
  t.after(async () => {
    await act(async () => { hydrated.unmount(); owner.unmount(); });
    first.remove();
    second.remove();
  });
  await act(async () => {});
  assert.deepEqual(errors, []);
  assert.equal(second.textContent, "missing");
});
