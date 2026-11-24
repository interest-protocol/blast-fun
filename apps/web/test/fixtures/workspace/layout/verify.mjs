import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";

const origin = new URL(process.env.LAYOUT_FIXTURE_URL ?? "http://127.0.0.1:42979");
assert.equal(origin.hostname, "127.0.0.1", "Use the controlled loopback fixture");
assert.ok(process.env.LAYOUT_CDP_URL, "Set LAYOUT_CDP_URL to the task-owned browser");
assert.ok(process.env.LAYOUT_EVIDENCE_DIR, "Set LAYOUT_EVIDENCE_DIR to a task output folder");
const output = process.env.LAYOUT_EVIDENCE_DIR;
const results = [];
let browser, page, cdp;
const errors = [];

before(async () => {
  await mkdir(output, { recursive: true });
  browser = await chromium.connectOverCDP(process.env.LAYOUT_CDP_URL);
  page = browser
    .contexts()[0]
    .pages()
    .find((candidate) => candidate.url().startsWith(origin.origin));
  assert.ok(page, "Open the fixture in the task-owned browser first");
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === origin.origin || url.protocol === "data:"
      ? route.continue()
      : route.abort();
  });
  cdp = await page.context().newCDPSession(page);
});

after(async () => {
  await writeFile(`${output}/results.json`, JSON.stringify({ results, errors }, null, 2));
  await browser?.close(); // Disconnect; agent-browser owns and closes the browser.
});

async function ready(width, coarse = false, theme = "light") {
  await page.setViewportSize({ width, height: 1000 });
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: coarse,
    maxTouchPoints: 1,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (!(await page.locator("[data-workspace-host]").count())) {
    await page.goto(origin.href, { waitUntil: "commit" });
  }
  await page.getByRole("button", { name: "Portfolio", exact: true }).waitFor();
  await page
    .getByRole("status")
    .filter({ hasText: "Saving workspace" })
    .waitFor({ state: "attached" });
  await page
    .getByRole("textbox", { name: "Draft ALPHA", exact: true, includeHidden: true })
    .waitFor({ state: "attached" });
  await page.evaluate(async (theme) => {
    document.querySelector("[data-blast-ui]").setAttribute("data-theme", theme);
    await document.fonts.ready;
  }, theme);
  await page.waitForFunction((coarse) => matchMedia("(pointer:coarse)").matches === coarse, coarse);
}

async function controlsFit(locator, touch = false) {
  const controls = await locator
    .locator("button:visible, a:visible, input:visible, select:visible")
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          // Coin chips scroll inside their list. CSS :visible includes clipped
          // chips too, so measure only the portion actually drawn in that list.
          const list = element.closest('nav[aria-label="Workspace panels"] ul');
          let left = rect.left,
            right = rect.right;
          if (list) {
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
              if (getComputedStyle(parent).overflowX !== "visible") {
                const clip = parent.getBoundingClientRect();
                left = Math.max(left, clip.left);
                right = Math.min(right, clip.right);
              }
            }
          }
          const hit = document.elementFromPoint((left + right) / 2, rect.y + rect.height / 2);
          return {
            name: element.getAttribute("aria-label") ?? element.textContent ?? element.tagName,
            x: left,
            y: rect.y,
            right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            reachable: element.contains(hit),
            disabled: element.matches(":disabled"),
          };
        })
        .filter((control) => control.right > control.x),
    );
  assert.ok(controls.length > 0, "Visible controls are present");
  for (const control of controls) {
    assert.ok(
      control.x >= -1 && control.right <= page.viewportSize().width + 1,
      JSON.stringify(control),
    );
    assert.ok(
      control.y >= -1 && control.bottom <= page.viewportSize().height + 1,
      JSON.stringify(control),
    );
    if (!control.disabled)
      assert.ok(control.reachable, `Hit target is covered: ${JSON.stringify(control)}`);
    if (touch)
      assert.ok(
        control.width >= 44 && control.height >= 44,
        `44px touch target: ${JSON.stringify(control)}`,
      );
  }
  for (let first = 0; first < controls.length; first++) {
    for (let next = first + 1; next < controls.length; next++) {
      const a = controls[first],
        b = controls[next];
      assert.ok(
        Math.min(a.right, b.right) - Math.max(a.x, b.x) <= 1 ||
          Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) <= 1,
        `Controls overlap: ${a.name}, ${b.name}`,
      );
    }
  }
  return controls;
}

test("audit 01/05: the workspace header keeps every visible control reachable without overlap at phone, tablet and desktop widths", async () => {
  for (const theme of ["light", "dark"]) {
    for (const width of [320, 407, 768, 1054, 1414]) {
      await ready(width, width < 1100, theme);
      const header = page.locator("[data-workspace-host] > header");
      const bounds = await controlsFit(header);
      assert.equal(
        await header
          .locator("[data-workspace-save-status]")
          .evaluate((element) => element.getBoundingClientRect().width),
        0,
        "The quiet save status takes no header width (owner, 2026-10-29)",
      );
      assert.ok(
        await header.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        `Header overflow at ${width}`,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      const layout = header.getByRole("button", {
        name: "Layout",
        exact: true,
      });
      const exit = header.getByRole("button", { name: /^Exit/ });
      const portfolio = header.getByRole("button", {
        name: "Portfolio",
        exact: true,
      });
      const row = await Promise.all([
        layout.boundingBox(),
        exit.boundingBox(),
        portfolio.boundingBox(),
      ]);
      assert.ok(
        Math.abs(row[0].y + row[0].height / 2 - row[1].y - row[1].height / 2) <= 1,
        "Layout and Exit stay on the app bar row",
      );
      if (width >= 768) {
        assert.ok(
          Math.abs(row[2].y + row[2].height / 2 - row[1].y - row[1].height / 2) <= 1,
          "Portfolio stays on the single app bar row",
        );
      }
      await layout.focus();
      assert.ok(
        await layout.evaluate((element) => element.matches(":focus-visible")),
        "Keyboard focus is visible",
      );
      await layout.click();
      await page.getByRole("menuitem", { name: "Keyboard shortcuts", exact: false }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "hidden" });
      assert.ok(await layout.evaluate((element) => element === document.activeElement));
      await page.screenshot({ path: `${output}/header-${theme}-${width}.png` });
      results.push({ behavior: "header", width, theme, controls: bounds });
    }
  }
  assert.deepEqual(errors, []);
});

test("#506/#614: More views and discovery pagination remain reachable with 44px touch targets", async () => {
  for (const [width, coarse] of [
    [320, true],
    [407, true],
    [768, true],
    [1054, true],
    [1414, false],
  ]) {
    await ready(width, coarse);
    await page.getByRole("button", { name: "Search coins and presales", exact: true }).click();
    // Live audit F33: More is the shared menu, not a native select, and names the open view.
    const more = page.getByRole("button", { name: /^More views:/ });
    await more.waitFor();
    const height = await more.evaluate((element) => element.getBoundingClientRect().height);
    assert.ok(height >= (coarse ? 44 : 28), String(height));
    await more.click();
    await page.getByRole("menuitemradio", { name: "Traders" }).click();
    await page.getByRole("button", { name: "More views: Traders", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Coins", exact: true }).click();
    const pager = page.getByRole("navigation", {
      name: "Pages of fixture coins",
    });
    const bounds = await controlsFit(pager, coarse);
    assert.equal(await pager.getByRole("button", { name: "Previous page" }).isDisabled(), true);
    await pager.getByRole("button", { name: "Next page" }).click();
    await page.getByText("Controlled discovery page 2", { exact: true }).waitFor();
    await pager.getByRole("button", { name: "Previous page" }).click();
    await page.getByText("Controlled discovery page 1", { exact: true }).waitFor();
    await pager.getByRole("button", { name: "Page 20", exact: true }).click();
    await page.getByText("Controlled discovery page 20", { exact: true }).waitFor();
    assert.equal(await pager.getByRole("button", { name: "Next page" }).isDisabled(), true);
    await controlsFit(pager, coarse);
    await page.screenshot({ path: `${output}/discovery-${width}.png` });
    results.push({
      behavior: "discovery",
      width,
      coarse,
      select,
      controls: bounds,
    });
    await pager.getByRole("button", { name: "Page 1", exact: true }).click();
    await page
      .getByRole("button", { name: /^(Close Discover|Collapse discovery)$/, exact: true })
      .click();
    await more.waitFor({ state: "hidden" });
  }
  assert.deepEqual(errors, []);
});

test("the focus chart expands over the whole viewport, keeps the trade card in place and Escape restores the chart and draft", async () => {
  await ready(1414);
  const chart = page.locator('[data-panel-id="ALPHA"] [data-workspace-section="chart"]');
  const trade = page.getByRole("region", { name: "ALPHA trade", exact: true });
  const draft = page.getByRole("textbox", { name: "Draft ALPHA", exact: true });
  await draft.fill("987.65");
  const before = {
    chart: await chart.boundingBox(),
    trade: await trade.boundingBox(),
  };
  await page.getByRole("button", { name: "Expand ALPHA panel", exact: true }).click();
  const restore = page.getByRole("button", {
    name: "Restore ALPHA panel",
    exact: true,
  });
  await restore.waitFor();
  await page.waitForFunction(
    () =>
      !document
        .querySelector('[data-panel-id="ALPHA"] [data-workspace-section="chart"]')
        .getAnimations()
        .some((animation) => animation.playState === "running"),
  );
  assert.deepEqual(await chart.boundingBox(), {
    x: 0,
    y: 0,
    ...page.viewportSize(),
  });
  assert.deepEqual(await trade.boundingBox(), before.trade, "Other sections keep their rectangles");
  assert.ok(
    await restore.evaluate((element) =>
      element.contains(
        document.elementFromPoint(
          element.getBoundingClientRect().x + 5,
          element.getBoundingClientRect().y + 5,
        ),
      ),
    ),
    "Restore is reachable above the shell",
  );
  await restore.focus();
  await page.screenshot({ path: `${output}/expanded-chart.png` });
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("[data-workspace-host]").count(),
    1,
    "Escape restores the chart without exiting",
  );
  await page.getByRole("button", { name: "Expand ALPHA panel", exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      !document
        .querySelector('[data-panel-id="ALPHA"] [data-workspace-section="chart"]')
        .getAnimations()
        .some((animation) => animation.playState === "running"),
  );
  assert.deepEqual(await chart.boundingBox(), before.chart);
  assert.deepEqual(await trade.boundingBox(), before.trade);
  assert.equal(await draft.inputValue(), "987.65");
  assert.deepEqual(errors, []);
  results.push({
    behavior: "expand",
    before,
    restored: await chart.boundingBox(),
  });
});
