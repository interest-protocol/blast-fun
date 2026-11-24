import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const out = process.env.AUDIT_OUTPUT;
if (!out || !process.env.AUDIT_CDP) throw new Error("AUDIT_OUTPUT and AUDIT_CDP are required");
await mkdir(`${out}/screenshots`, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.AUDIT_CDP);
const page = browser.contexts()[0].pages()[0];
const cdp = await page.context().newCDPSession(page);
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const counters = () => page.evaluate(() => ({ prepares: auditWallet.prepares, executes: auditWallet.executes, refreshes: auditWallet.refreshes }));
const close = async () => { await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({ state: "hidden" }); };
const button = name => page.getByRole("button", { name, exact: true });
async function fillCreation(amount) {
  await button("Select coin").click();
  await page.getByRole("button", { name: /^SUI$/ }).click();
  await page.getByRole("textbox", { name: "Amount to lock", exact: true }).fill(amount);
  if (await button("Use connected wallet").isEnabled()) await button("Use connected wallet").click();
  else await page.getByRole("textbox", { name: "Recipient wallet", exact: true }).fill(`0x${"a".repeat(64)}`);
  for (const [label, values] of [["Start date", ["15", "01", "2027"]], ["End date", ["15", "02", "2027"]]]) {
    for (const [segment, value] of [["day", values[0]], ["month", values[1]], ["year", values[2]]]) {
      await page.getByRole("spinbutton", { name: `${segment}, ${label}`, exact: true }).focus();
      await page.keyboard.type(value);
      await page.keyboard.press("Tab");
    }
  }
}
const results = [];
async function capture(name, width) {
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1);
  const screenshot = async theme => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(`${out}/screenshots/${name}-${width}-${theme}.png`, Buffer.from(data, "base64"));
  };
  await screenshot("light");
  if ([407, 1414].includes(width)) {
    // Change the underlying theme without dismissing a review.
    await page.evaluate(() => document.querySelector('[data-blast-ui]').setAttribute("data-theme", "dark"));
    await screenshot("dark");
    await page.evaluate(() => document.querySelector('[data-blast-ui]').setAttribute("data-theme", "light"));
  }
}
for (const width of [320, 407, 768, 1054, 1414]) {
  await page.setViewportSize({ width, height: 900 });
  for (const view of ["detail", "vesting"]) {
    console.log(`${view} ${width} starting`);
    await page.goto(`http://127.0.0.1:42973/?view=${view}`);
    await page.getByRole("combobox", { name: "Fixture account", exact: true }).waitFor();
    if (view === "vesting") {
      const account = page.getByRole("combobox", { name: "Fixture account", exact: true });
      await account.selectOption("signed-out");
      await fillCreation("1");
      await account.selectOption("A");
      assert.equal(await page.getByRole("textbox", { name: "Amount to lock", exact: true }).inputValue(), "1");
    }
    await button(view === "detail" ? "Claim vested coins" : "Review vesting").click();
    await button(view === "detail" ? "Confirm in wallet" : "Create vesting in wallet").click();
    await button("Check transaction status").waitFor();
    await capture(`${view}-A-pending`, width);
    await close();
    const account = page.getByRole("combobox", { name: "Fixture account", exact: true });
    await account.selectOption("signed-out");
    assert.equal(await button("Check transaction status").count(), 0);
    await account.selectOption("B");
    assert.equal(await button("Check transaction status").count(), 0);
    if (view === "vesting") {
      assert.equal(await page.locator("fieldset").first().isDisabled(), false);
      assert.equal(await page.getByRole("textbox", { name: "Amount to lock", exact: true }).inputValue(), "");
      await fillCreation("2");
    }
    await capture(`${view}-B-ready`, width);
    await button(view === "detail" ? "Claim vested coins" : "Review vesting").click();
    await button(view === "detail" ? "Confirm in wallet" : "Create vesting in wallet").waitFor();
    assert.deepEqual(await counters(), { prepares: 2, executes: 1, refreshes: 0 });
    await close();
    await account.selectOption("A");
    if (view === "vesting") {
      assert.equal(await page.getByRole("textbox", { name: "Amount to lock", exact: true }).inputValue(), "1");
      assert.equal(await page.getByRole("textbox", { name: "Amount to lock", exact: true }).isDisabled(), true);
    }
    await button("Check transaction status").click();
    await page.getByRole("dialog").getByRole("button", { name: "Check transaction status", exact: true }).click();
    assert.deepEqual(await counters(), { prepares: 2, executes: 1, refreshes: 1 });
    assert.ok(await page.getByRole("dialog").locator('a[href*="fixture-original-digest"]').count() > 0);
    await capture(`${view}-A-recovered`, width);
    results.push({ view, width, passed: true });
    console.log(`${view} ${width} passed`);
  }
}
// Auth providers can change the owner while a review is still open.
const before = await counters();
const switchAccount = async value => {
  await page.locator("label").filter({ hasText: "Fixture account" }).locator("select").evaluate((select, next) => {
    select.value = next;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
};
await switchAccount("B");
await page.getByRole("dialog").waitFor({ state: "hidden" });
assert.equal(await button("Check transaction status").count(), 0);
assert.equal(await page.locator("fieldset").first().isDisabled(), false);
await switchAccount("A");
await page.getByRole("dialog").waitFor();
await page.getByRole("dialog").getByRole("button", { name: "Check transaction status", exact: true }).waitFor();
assert.deepEqual(await counters(), before);
assert.deepEqual(errors, []);
await writeFile(`${out}/account-browser-results.json`, JSON.stringify({ results, errors }, null, 2));
console.log(JSON.stringify({ passed: results.length, errors }));
await browser.close();
