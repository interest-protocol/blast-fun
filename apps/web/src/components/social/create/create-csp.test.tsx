import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToString } from "react-dom/server";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const { act } = await import("react");
const { hydrateRoot } = await import("react-dom/client");
const { CreateView } = await import("./CreateView");
const { createStore } = await import("./create-store");
const { SplitBar } = await import("#web/components/blast-ui/SplitBar.tsx");
const { StyleNonceContext } = await import("../../ui-libraries/style-nonce");
const { splitShades } = await import("./create-colors");
const NONCE = "createStylesTestNonce0123456789abcdef";
const css = readFileSync(new URL("../../blast-ui/blast-ui.css", import.meta.url), "utf8");

test("Create allocation widths and colors are present before hydration under strict CSP", () => {
  createStore.reset({ phase: "visitor", step: "raise" });
  const page = <StyleNonceContext value={NONCE}><CreateView state={createStore.get()} onLogo={() => undefined} onList={() => undefined} onRetry={() => undefined} signIn={null} /></StyleNonceContext>;
  const container = dom.document.createElement("div");
  container.innerHTML = renderToString(page);
  dom.document.body.append(container);
  try {
    assert.equal(container.querySelectorAll(".split-bar").length, 3);
    const elements = [...container.querySelectorAll<HTMLElement>(".split-bar i, .dot")];
    assert.ok(elements.length > 0);
    for (const element of elements) {
      assert.equal(element.hasAttribute("style"), false, "allocation styles must not use blocked HTML style attributes");
      assert.equal(element.hasAttribute("data-csp-style"), false, "allocation styles must not wait for hydration");
      const color = element.getAttribute("data-cr-color");
      assert.ok(color && css.includes(`[data-cr-color="${color}"]`), "the external stylesheet supplies every allocation color");
      if (element.closest(".split-bar")) assert.ok(Number.parseFloat(dom.window.getComputedStyle(element).flex) > 0, "server-rendered stylesheet supplies the proportional width");
    }
    for (const shade of splitShades(Array.from({ length: 12 }, () => 100))) assert.ok(css.includes(`[data-cr-color="${shade}"]`), "every split shade is supported");
    const neutral = /^var\(--(ink|ink-tint-[123]|faint)\)$/;
    for (const element of elements) assert.match(element.getAttribute("data-cr-color") ?? "", neutral, "data series stay in ink and grey");
    for (const sheet of container.querySelectorAll("style")) assert.equal(sheet.nonce, NONCE, "dynamic styles carry the request nonce");
  } finally {
    container.remove();
    createStore.reset();
  }
});

test("allocation styles remain scoped and update when shares change after hydration", async () => {
  const page = (parts: readonly (readonly [number, string, string])[]) => <StyleNonceContext value={NONCE}><SplitBar parts={parts} /><SplitBar parts={[[2500, "var(--ink-tint-1)", "Pool"], [7500, "var(--ink)", "Buyers"]]} /></StyleNonceContext>;
  const initial = page([[4500, "var(--ink)", "Buyers"], [5500, "var(--ink-tint-1)", "Pool"]]);
  const container = dom.document.createElement("div");
  container.innerHTML = renderToString(initial);
  dom.document.body.append(container);
  const shares = () => [...container.querySelectorAll(".split-bar i")].map((element) => Number.parseFloat(dom.window.getComputedStyle(element).flex));
  const errors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    assert.deepEqual(shares(), [4500, 5500, 2500, 7500]);
    await act(async () => { root = hydrateRoot(container, initial, { onRecoverableError: (error) => errors.push(error) }); });
    await act(async () => { root!.render(page([[0, "var(--ink)", "Buyers"], [6000, "var(--ink-tint-1)", "Pool"], [4000, "var(--ink-tint-2)", "Team"], [NaN, "var(--faint)", "Invalid"], [Infinity, "var(--faint)", "Invalid"], [-100, "var(--faint)", "Invalid"]])); });
    assert.deepEqual(shares(), [6000, 4000, 2500, 7500]);
    assert.deepEqual(errors, []);
    for (const sheet of container.querySelectorAll("style")) assert.equal(sheet.nonce, NONCE);
  } finally {
    if (root) await act(async () => root!.unmount());
    container.remove();
  }
});

test("split shades alternate dark and light by place, so neighbouring segments never sit close", () => {
  const dark = new Set(["var(--ink)", "var(--ink-tint-1)"]);
  const shades = splitShades([4000, 2000, 500, 0, 100, 100, 100, 3200]);
  const shown = shades.filter((_, index) => index !== 3);
  for (const [index, shade] of shown.entries()) {
    assert.match(shade, /^var\(--(ink|ink-tint-[123])\)$/);
    if (index > 0) assert.notEqual(dark.has(shade), dark.has(shown[index - 1]!), `${shown[index - 1]} next to ${shade}`);
  }
  assert.equal(shades[3], shades[4], "a part at zero takes the shade the next part would");
  // Light theme: tint 1 is on ink's side, tints 2 and 3 on the light side; neighbours alternate at 3:1 or more.
  const tokens = Object.fromEntries([...css.matchAll(/--ink-tint-(\d): (#[0-9a-f]{6})/g)].slice(0, 3).map(([, n, hex]) => [n, hex!]));
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
  const order = ["#1d1d1f", tokens["2"]!, tokens["1"]!, tokens["3"]!, "#1d1d1f"];
  for (let index = 1; index < order.length; index += 1) assert.ok(ratio(order[index - 1]!, order[index]!) >= 3, `${order[index - 1]} vs ${order[index]}`);
});
