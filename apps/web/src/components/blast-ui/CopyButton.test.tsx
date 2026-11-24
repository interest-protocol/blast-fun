import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CopyButton } = await import("./CopyButton");

test("copy confirms only a successful write, resets after 1.8 seconds, and rejects duplicate pending clicks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  let writes = 0;
  let result = Promise.withResolvers<boolean>();
  const copy = () => { writes++; return result.promise; };
  await act(async () => root.render(<CopyButton label="Copy address" onCopy={copy}>Copy address</CopyButton>));
  const button = container.querySelector("button")!;
  await act(async () => { button.click(); button.click(); });
  assert.equal(writes, 1);
  assert.equal(button.hasAttribute("data-copied"), false);
  await act(async () => result.resolve(true));
  assert.equal(button.getAttribute("aria-label"), "Copied");
  assert.equal(container.querySelector('[role="status"]')?.textContent, "Copied to clipboard");
  await act(async () => t.mock.timers.tick(1800));
  assert.equal(button.getAttribute("aria-label"), "Copy address");
  result = Promise.withResolvers<boolean>();
  await act(async () => button.click());
  await act(async () => result.reject(new Error("Clipboard denied")));
  assert.equal(button.hasAttribute("data-copied"), false);
  assert.equal(container.querySelector('[role="status"]')?.textContent, "");
  result = Promise.withResolvers<boolean>();
  await act(async () => button.click());
  await act(async () => result.resolve(false));
  assert.equal(button.hasAttribute("data-copied"), false);
});

test("variants and sizes: ghost by default, the Settings board's filled Copy chip without a glyph, and a primary with its glyph", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const copy = () => true;
  await act(async () => root.render(<>
    <CopyButton label="Copy coin type" onCopy={copy} />
    <CopyButton label="Copy Blast wallet address" onCopy={copy} variant="secondary">Copy</CopyButton>
    <CopyButton label="Copy invite link" onCopy={copy} size="md" variant="primary">Invite</CopyButton>
    <CopyButton label="Copy address" onCopy={copy} size="chip" variant="secondary" />
  </>));
  const [ghost, secondary, primary, iconChip] = [...container.querySelectorAll("button")];
  assert.equal(ghost!.getAttribute("data-ui-variant"), "ghost");
  assert.equal(ghost!.getAttribute("data-ui-size"), "xs");
  assert.ok(ghost!.hasAttribute("data-ui-icon"));
  assert.equal(secondary!.getAttribute("data-ui-variant"), "secondary");
  assert.equal(secondary!.getAttribute("data-ui-size"), "xs");
  assert.equal(secondary!.querySelector("svg"), null, "the filled chip reads Copy with no glyph");
  assert.equal(secondary!.textContent, "Copy");
  assert.equal(primary!.getAttribute("data-ui-variant"), "primary");
  assert.equal(primary!.getAttribute("data-ui-size"), "md");
  assert.equal(primary!.querySelectorAll("svg").length, 2, "copy and check glyphs, one shown at a time");
  assert.ok(iconChip!.hasAttribute("data-ui-icon"), "without a label the secondary keeps its glyph");
  assert.equal(iconChip!.getAttribute("data-ui-size"), "chip");
  assert.ok(iconChip!.querySelector("svg"));
  await act(async () => { secondary!.click(); });
  assert.equal(secondary!.getAttribute("aria-label"), "Copied");
  assert.match(secondary!.textContent!, /^Copied/);
});
