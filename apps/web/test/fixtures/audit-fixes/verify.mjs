import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const out = process.env.AUDIT_OUTPUT;
if (!out) throw new Error("AUDIT_OUTPUT is required");
await mkdir(`${out}/screenshots`, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.AUDIT_CDP ?? "http://127.0.0.1:35579");
const context = browser.contexts()[0];
const page = context.pages()[0];
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const results = [];
const base = "http://127.0.0.1:42973/";
async function open(view, width = 407) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${base}?view=${view}`);
  await page.getByRole("combobox", { name: "Surface", exact: true }).waitFor();
  await page.waitForTimeout(250);
}
async function shot(name) { await page.screenshot({ path: `${out}/screenshots/${name}.png`, fullPage: true }); }
for (const view of (process.env.AUDIT_INTERACTIONS_ONLY ? [] : ["settings", "settings-ready", "portfolio", "create", "vesting", "detail", "picker-unknown", "picker-known", "chart", "unknown", "legal", "position-open", "position"])) {
  for (const width of [320, 407, 768, 1054, 1414]) {
    await open(view, width);
    if (view === "position" || view === "position-open") await page.getByRole("alert").filter({ hasText: "Your position could not load" }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 1) throw new Error(`${view} ${width}: document overflow ${overflow}px`);
    if (view === "settings") {
      const names = await page.getByRole("switch").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));
      assert.deepEqual(names, ["Sound", "Celebrations"]);
      assert.ok(await page.getByText("Unavailable", { exact: true }).count() >= 9);
    }
    if (view === "picker-unknown") {
      assert.ok(await page.getByText("Balance unavailable", { exact: true }).count() > 0);
      assert.equal(await page.getByText("Balance", { exact: true }).count(), 0);
    }
    if (view === "chart") {
      await page.locator('[data-tradingview-plot][data-ready="true"]').waitFor();
      assert.ok(await page.locator('[data-tradingview-plot] canvas').count() > 0);
      const frame = page.getByRole("group", { name: "Inspect price history" });
      await frame.focus(); await page.keyboard.press("Home");
      const first = await page.locator('[data-active="true"] time').getAttribute("datetime");
      await page.keyboard.press("End");
      const last = await page.locator('[data-active="true"] time').getAttribute("datetime");
      assert.notEqual(first, last);
      await page.keyboard.press("Escape");
    }
    if (view === "create") {
      const links = await page.locator('nav[aria-label="Presale sections"] a').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, box: node.getBoundingClientRect().toJSON() })));
      assert.equal(links.length, 5);
      for (let i = 1; i < links.length; i++) assert.ok(links[i].box.x >= links[i-1].box.right, "Section labels overlap");
    }
    await shot(`${view}-${width}-light`);
    if ([407,1414].includes(width)) {
      await page.getByRole("button", { name: "Toggle theme", exact: true }).click();
      await shot(`${view}-${width}-dark`);
    }
    results.push({ view, width, overflow, status: "pass" });
    console.log(`PASS ${view} ${width}`);
  }
}
for (const width of [320, 407, 768, 1054, 1414]) {
  await open("chart", width);
  const frame = page.getByRole("group", { name: "Inspect price history" });
  assert.ok((await frame.boundingBox()).height > 200);
  await frame.focus(); await page.keyboard.press("ArrowRight");
  await page.locator('[data-active="true"] time').waitFor();
  await shot(`chart-inspection-${width}-light`);
  await page.keyboard.press("Escape");
  await shot(`chart-${width}-light`);
  if ([407, 1414].includes(width)) { await page.getByRole("button", { name: "Toggle theme", exact: true }).click(); await shot(`chart-${width}-dark`); }
}
await open("settings-ready");
await page.getByRole("button", { name: /^Inspect full Blast wallet address/ }).focus();
await page.keyboard.press("Enter");

const popup = page.getByRole("button", { name: "Copy full Blast wallet address", exact: true });
await popup.waitFor();
await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Controlled clipboard failure"); } } }));
await popup.click();
assert.ok(await page.locator('code[tabindex="0"]').filter({ hasText: "0x" + "a".repeat(64) }).isVisible());
await shot("settings-address-copy-failure");
await page.keyboard.press("Escape");
await open("detail");
await page.getByRole("button", { name: "Claim vested coins", exact: true }).click();
await page.getByRole("button", { name: "Confirm in wallet", exact: true }).click();
await page.getByRole("button", { name: "Check transaction status", exact: true }).waitFor();
await shot("detail-pending");
await page.keyboard.press("Escape");
await page.getByRole("dialog").waitFor({ state: "hidden" });
await page.getByRole("button", { name: "Check transaction status", exact: true }).click();
await page.getByRole("dialog").getByRole("button", { name: "Check transaction status", exact: true }).click();
await page.waitForFunction(() => auditWallet.refreshes === 1);
assert.deepEqual(await page.evaluate(() => ({ prepares: auditWallet.prepares, executes: auditWallet.executes, refreshes: auditWallet.refreshes })), { prepares: 1, executes: 1, refreshes: 1 });
await shot("detail-pending-reopened");
await open("create");
await page.evaluate(() => auditFixture.store.set({ reviewOpen: true }));
await page.getByRole("heading", { name: "Review your presale", exact: true }).waitFor();
assert.ok(await page.getByRole("button", { name: /^Inspect full recipient address/ }).count() >= 5);
await shot("presale-review-destinations");
await page.keyboard.press("Escape");
await open("vesting");
await page.getByRole("button", { name: "Select coin", exact: true }).click();
await page.getByRole("button", { name: /^SUI$/ }).click();
await page.getByRole("textbox", { name: "Amount to lock", exact: true }).fill("1");
await page.getByRole("button", { name: "Use connected wallet", exact: true }).click();
// React Aria date segments exercise the same controlled fields as calendar selection.
for (const [label, values] of [["Start date", ["15", "01", "2027"]], ["End date", ["15", "02", "2027"]]]) {
  for (const [segment, value] of [["day", values[0]], ["month", values[1]], ["year", values[2]]]) {
    const target = page.getByRole("spinbutton", { name: `${segment}, ${label}`, exact: true });
    await target.focus(); await page.keyboard.type(value); await page.keyboard.press("Tab");
  }
}
await page.getByRole("button", { name: "Review vesting", exact: true }).click();
await page.getByRole("button", { name: "Create vesting in wallet", exact: true }).waitFor();
await shot("creation-utc-review");
await page.getByRole("button", { name: "Create vesting in wallet", exact: true }).click();
await page.getByRole("button", { name: "Check transaction status", exact: true }).waitFor();
await shot("creation-pending");
await page.keyboard.press("Escape");
await page.getByRole("dialog").waitFor({ state: "hidden" });
await page.getByRole("button", { name: "Check transaction status", exact: true }).click();
await page.getByRole("dialog").getByRole("button", { name: "Check transaction status", exact: true }).click();
assert.deepEqual(await page.evaluate(() => ({ prepares: auditWallet.prepares, executes: auditWallet.executes, refreshes: auditWallet.refreshes })), { prepares: 1, executes: 1, refreshes: 1 });
await shot("creation-pending-reopened");
await page.emulateMedia({ reducedMotion: "reduce", contrast: "more" });
await open("settings-ready", 320);
await page.getByRole("button", { name: /^Inspect full Blast wallet address/ }).click();
await shot("address-320-reduced-motion-contrast");
await writeFile(`${out}/browser-results.json`, JSON.stringify({ results, interactions: "passed", errors }, null, 2));
assert.deepEqual(errors, []);
console.log(JSON.stringify({ matrix: results.length, interactions: "passed", errors }));
// Leave task-owned browser open for independent capture review; root closes it afterward.
await browser.close();
