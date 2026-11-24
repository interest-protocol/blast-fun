import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot, hydrateRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { Collapse } = await import("./Collapse");

test("server disclosures omit CSP-blocked styles and hydrate with working dimensions", async () => {
  for (const open of [false, true]) {
    const view = <Collapse open={open}><input defaultValue="saved address" /></Collapse>;
    const html = renderToString(view);
    assert.doesNotMatch(html, / style="/);
    assert.match(html, /value="saved address"/);
    assert.equal(html.includes('inert=""'), !open);
    assert.equal(html.includes('hidden=""'), !open);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const errors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => { root = hydrateRoot(container, view, { onRecoverableError: (error) => errors.push(error) }); });
      assert.deepEqual(errors, []);
      assert.match(container.querySelector("input")!.parentElement!.getAttribute("style") ?? "", /--collapsible-panel-height:/);
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  }
});

test("hiding a focused region returns focus immediately and retains inert input values through reversal", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (open: boolean) => root.render(<><button id="toggle">Toggle</button>
    <Collapse open={open} focusOnClose={() => document.getElementById("toggle")}><input defaultValue="saved address" /></Collapse></>);
  try {
    await act(async () => render(true));
    const input = container.querySelector("input")!;
    assert.match(input.parentElement!.getAttribute("style") ?? "", /--collapsible-panel-height:/);
    input.focus();
    await act(async () => render(false));
    assert.equal(document.activeElement?.id, "toggle");
    assert.ok(input.closest('[inert][aria-hidden="true"]'));
    await act(async () => render(true));
    assert.equal(container.querySelector("input"), input);
    assert.equal(input.value, "saved address");
    assert.equal(input.closest("[inert]"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
