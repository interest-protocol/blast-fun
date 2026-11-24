import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright-core";

const origin = new URL(process.env.ACTIVITY_FIXTURE_URL ?? "http://127.0.0.1:42989");
assert.equal(origin.hostname, "127.0.0.1", "Use the controlled loopback fixture");
assert.ok(process.env.ACTIVITY_CDP_URL, "Set ACTIVITY_CDP_URL to the task-owned browser");
assert.ok(process.env.ACTIVITY_EVIDENCE_DIR, "Set ACTIVITY_EVIDENCE_DIR to a task output folder");

test("real trusted pointer and keyboard input emit after cooldown while scripted input, idle time and unmounted input do not", async () => {
  const browser = await chromium.connectOverCDP(process.env.ACTIVITY_CDP_URL);
  assert.ok(
    browser
      .contexts()[0]
      .pages()
      .some((candidate) => candidate.url().startsWith(origin.origin)),
    "Open the fixture in the task-owned browser first",
  );
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin && url.protocol !== "data:") {
      return route.abort();
    }
    if (url.pathname === "/api/analytics/activity") {
      requests.push({
        method: request.method(),
        body: request.postData(),
        authorization: request.headers().authorization ?? null,
      });
      return route.fulfill({ status: 204 });
    }
    return route.continue();
  });
  async function settled() {
    // A browser task boundary, rather than elapsed wall time or a network-idle heuristic.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  try {
    await page.clock.install({ time: new Date("2026-11-16T12:00:00Z") });
    await page.goto(origin.href);
    await page.getByRole("button", { name: "Activity target" }).waitFor();
    await page.waitForFunction(() => window.activityFixture !== undefined);
    await settled();
    assert.equal(requests.length, 1, "Strict Mode has one foreground entry request");
    assert.deepEqual(requests[0], {
      method: "POST",
      body: null,
      authorization: null,
    });
    await page.clock.setFixedTime(new Date("2026-11-16T12:16:00Z"));
    await settled();
    assert.equal(requests.length, 1, "the cooldown does not schedule a heartbeat");
    await page.evaluate(() => {
      document.dispatchEvent(new PointerEvent("pointerdown"));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settled();
    assert.equal(requests.length, 1, "synthetic events are not foreground activity");
    await page.getByRole("button", { name: "Activity target" }).click();
    await settled();
    assert.equal(requests.length, 2, "a real pointer event is activity");
    await page.clock.setFixedTime(new Date("2026-11-16T12:32:00Z"));
    await page.getByRole("textbox", { name: "Keyboard target" }).focus();
    await page.keyboard.press("A");
    await settled();
    assert.equal(requests.length, 3, "a real keyboard event is activity");
    const signals = await page.evaluate(() => window.activityFixture.signals);
    assert.ok(signals.some((signal) => signal.type === "pointerdown" && signal.trusted));
    assert.ok(signals.some((signal) => signal.type === "keydown" && signal.trusted));
    assert.equal(signals.filter((signal) => !signal.trusted).length, 2);
    await page.evaluate(() => window.activityFixture.stop());
    await settled();
    await page.clock.setFixedTime(new Date("2026-11-16T12:48:00Z"));
    await page.keyboard.press("B");
    await settled();
    assert.equal(requests.length, 3);
    assert.deepEqual(errors, []);
    await mkdir(process.env.ACTIVITY_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: `${process.env.ACTIVITY_EVIDENCE_DIR}/trusted-input.png`,
    });
    await writeFile(
      `${process.env.ACTIVITY_EVIDENCE_DIR}/trusted-input.json`,
      JSON.stringify({ requests, signals, errors }, null, 2),
    );
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    try {
      await context.close();
    } finally {
      await browser.close();
    }
  }
});
