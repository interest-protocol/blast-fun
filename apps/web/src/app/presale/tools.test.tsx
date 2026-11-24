import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "next/navigation") return { url: 'data:text/javascript,export function redirect(path){throw new Error(`redirect:${path}`)};export function notFound(){throw new Error("not-found")}', shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { default: NewAllowlistPage } = await import("./(tools)/allowlists/new/page");
const { default: PresaleReceiptPage } = await import("./(tools)/[presaleId]/receipt/[wallet]/page");
hooks.deregister();
test("legacy allowlist creation opens the supported Create workflow", () => {
  assert.throws(NewAllowlistPage, /redirect:\/create/);
});
test("receipt utility preserves validated sale navigation and semantic landmarks", async () => {
  const id = `0x${"1".repeat(64)}`;
  const html = renderToStaticMarkup(await PresaleReceiptPage({ params: Promise.resolve({ presaleId: id, wallet: "unused" }) }));
  assert.match(html, /Receipt unavailable/);
  assert.match(html, new RegExp(`href="/presale/${id}"`));
  assert.doesNotMatch(html, /<main/);
  await assert.rejects(PresaleReceiptPage({ params: Promise.resolve({ presaleId: "invalid", wallet: "unused" }) }), /not-found/);
});
