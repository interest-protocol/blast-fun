import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";

const fixture = new URL(
  process.env.TYPOGRAPHY_FIXTURE_URL ??
    "http://127.0.0.1:42863/typography-proof",
);
assert.equal(
  fixture.hostname,
  "127.0.0.1",
  "Use the controlled loopback Next fixture",
);
assert.equal(fixture.pathname, "/typography-proof");
assert.ok(
  process.env.TYPOGRAPHY_CDP_URL,
  "Set TYPOGRAPHY_CDP_URL to the task-owned browser",
);
assert.ok(
  process.env.TYPOGRAPHY_EVIDENCE_DIR,
  "Set TYPOGRAPHY_EVIDENCE_DIR to a task output folder",
);
const output = process.env.TYPOGRAPHY_EVIDENCE_DIR;
const results = [],
  errors = [],
  fontResponses = [],
  blocked = [];
let browser, page, cdp;

before(async () => {
  await mkdir(output, { recursive: true });
  browser = await chromium.connectOverCDP(process.env.TYPOGRAPHY_CDP_URL);
  page = browser.contexts()[0].pages()[0];
  assert.ok(page, "Open the task-owned browser first (about:blank is enough)");
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (/\.(woff2?|ttf)(?:\?|$)/.test(response.url())) {
      fontResponses.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
    }
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.origin && url.protocol !== "data:") {
      blocked.push(url.origin);
      return route.abort();
    }
    // The real shell polls health. This is the only controlled data response;
    // font CSS/files and every component come from the real Next compilation.
    if (url.pathname === "/api/social/health")
      return route.fulfill({
        json: {
          checkedAt: Date.now(),
          backend: "healthy",
          sui: { status: "healthy", checkpoint: "1", timestampMs: Date.now() },
        },
      });
    // Next Link prefetch is irrelevant to type and must not compile other fixture routes.
    if (route.request().headers()["next-router-prefetch"]) return route.abort();
    return route.continue();
  });
  await page.addInitScript(() => {
    if (location.protocol !== "http:") return;
    localStorage.setItem("blast.railMini", "false");
    localStorage.setItem("blast.theme", '"light"');
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1414, height: 1000 });
  // Leave any previous Next HMR connection before loading a new source state.
  await page.goto("about:blank");
  await page.goto(fixture.href, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: "Shell typography proof", exact: true })
    .waitFor();
  cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
});

after(async () => {
  await writeFile(
    `${output}/results.json`,
    JSON.stringify({ results, errors, fontResponses, blocked }, null, 2),
  );
  await browser?.close(); // Disconnect; agent-browser owns browser shutdown.
});

async function ready(width, theme) {
  await page.setViewportSize({ width, height: 1000 });
  await page.evaluate(async (theme) => {
    document.querySelector("[data-blast-ui]").setAttribute("data-theme", theme);
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  }, theme);
}

async function measure(selector) {
  const value = await page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    return {
      text: element.textContent,
      family: style.fontFamily,
      weight: style.fontWeight,
      size: parseFloat(style.fontSize),
      lineHeight: parseFloat(style.lineHeight),
      tracking:
        style.letterSpacing === "normal" ? 0 : parseFloat(style.letterSpacing),
      numeric: style.fontVariantNumeric,
      optical: style.fontOpticalSizing,
      opacity: style.opacity,
      textWidth: text.width,
      textHeight: text.height,
    };
  });
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  return { ...value, fonts };
}

function close(actual, expected, name) {
  assert.ok(
    Math.abs(actual - expected) < 0.02,
    `${name}: ${actual}, expected ${expected}`,
  );
}

function role(actual, { family, weight, size, tracking, lineHeight }) {
  // Computed family alone passes when a font download fails. CDP reports the
  // actual face used to draw the text, including whether it is a custom font.
  const drawn = actual.fonts.filter((font) => font.glyphCount > 0);
  assert.ok(drawn.length > 0, `${actual.text}: rendered glyphs`);
  for (const font of drawn) {
    assert.ok(
      font.isCustomFont && family.test(font.familyName),
      `${actual.text}: ${JSON.stringify(font)}`,
    );
  }
  assert.equal(actual.weight, String(weight), actual.text);
  close(actual.size, size, `${actual.text} size`);
  close(actual.tracking, tracking, `${actual.text} tracking`);
  if (lineHeight !== undefined)
    close(actual.lineHeight, lineHeight, `${actual.text} line height`);
  assert.equal(actual.optical, "auto", actual.text);
}

async function checkType(width, theme) {
  await ready(width, theme);
  const phone = width <= 760;
  // The approved bounded phone scale grows rem type above the 390px board.
  const scale = phone ? Math.max(16, Math.min(18, width * 0.041026)) / 16 : 1;
  close(
    await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    ),
    16 * scale,
    "Root text scale",
  );
  const values = {
    body: await measure("#typography-body"),
    brand: await measure(
      `${phone ? "[data-shell-topbar]" : "[data-shell-rail]"} a[aria-label='Blast home'] b`,
    ),
    title: await measure("[data-page-head] h1"),
    sheet: await measure("#typography-sheet"),
  };
  results.push({ width, theme, values });
  role(values.body, {
    family: /^Geist$/,
    weight: 400,
    size: 15 * scale,
    tracking: 0,
  });
  role(values.brand, {
    family: /Bricolage Grotesque/,
    weight: 700,
    size: (phone ? 21 : 23) * scale,
    tracking: (phone ? -0.84 : -0.92) * scale,
  });
  role(values.title, {
    family: /Bricolage Grotesque/,
    weight: 650,
    size: (phone ? 32 : 36) * scale,
    tracking: (phone ? -1.28 : -1.44) * scale,
    lineHeight: (phone ? 35.2 : 37.8) * scale,
  });
  role(values.sheet, {
    family: /^Geist$/,
    weight: 650,
    size: 22 * scale,
    tracking: -0.55 * scale,
    lineHeight: 28.6 * scale,
  });
  // Retain the token fallback contract as resolved browser values, without
  // requiring one serialization of var() whitespace in the stylesheet.
  assert.ok(
    values.title.family.includes(values.body.family),
    "Display falls back through the UI font stack",
  );
  const faces = await page.evaluate(() =>
    [...document.fonts].map(({ family, weight, status }) => ({
      family,
      weight,
      status,
    })),
  );
  results.at(-1).faces = faces;
  for (const value of [values.body, values.title]) {
    const primary = value.family.split(",")[0].trim().replaceAll('"', "");
    assert.ok(
      faces.some((face) => {
        const weights = face.weight.split(" ").map(Number);
        return (
          face.family.replaceAll('"', "") === primary &&
          face.status === "loaded" &&
          weights.length === 2 &&
          weights[0] <= 400 &&
          weights[1] >= 700
        );
      }),
      `A loaded ${primary} variable face covers body and intermediate title weights: ${JSON.stringify(faces)}`,
    );
  }
  await page.screenshot({
    path: `${output}/${theme}-${width}.png`,
    fullPage: true,
  });
}

test("OA-31/OA-32: the real Next fonts draw body, wordmark, page title and sheet at phone and desktop sizes", async () => {
  for (const theme of ["light", "dark"]) {
    for (const width of [320, 407, 768, 1054, 1414]) {
      await checkType(width, theme);
    }
  }
  assert.ok(fontResponses.length > 0, "Actual font files were served by Next");
  assert.ok(
    fontResponses.every((response) => response.status === 200),
    JSON.stringify(fontResponses),
  );
  assert.deepEqual(
    blocked,
    [],
    "The browser needs no external font or service requests",
  );
  assert.deepEqual(errors, [], "No browser runtime errors");
});

async function checkNavigation(width) {
  await ready(width, "light");
  if (width === 1414) {
    await page
      .getByRole("button", { name: "Collapse sidebar", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-blast-ui]").getAttribute("data-rail") ===
        "mini",
    );
    await page.waitForFunction(
      () =>
        getComputedStyle(
          document.querySelector(
            "[data-shell-rail] a[aria-label='Blast home'] b",
          ),
        ).opacity === "0",
      undefined,
      { timeout: 5_000 },
    );
    assert.equal(
      (await measure("[data-shell-rail] a[aria-label='Blast home'] b")).opacity,
      "0",
    );
  }
  const nav = page.getByRole("navigation", {
    name: width === 407 ? "Tabs" : "Primary",
    exact: true,
  });
  const names =
    width === 407
      ? ["Home", "Swap", "Presales", "Bonding", "More"]
      : ["Home", "Swap", "Presales", "Bonding", "Portfolio", "Create"];
  const labels = [];
  for (const name of names) {
    const control = nav.getByRole(
      ["Home", "Presales", "Bonding", "Portfolio"].includes(name) ? "link" : "button",
      { name, exact: true },
    );
    const value = await control.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const texts = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (node.textContent.trim()) texts.push(node);
      const node = texts.find(
        (candidate) =>
          candidate.textContent.trim() === element.textContent.trim(),
      );
      if (!node) throw new Error(`Missing label for ${element.textContent}`);
      const range = document.createRange();
      range.selectNode(node);
      const text = range.getBoundingClientRect(),
        icon = element.querySelector("svg").getBoundingClientRect();
      const style = getComputedStyle(node.parentElement);
      return {
        text: node.textContent.trim(),
        size: parseFloat(style.fontSize),
        tracking:
          style.letterSpacing === "normal"
            ? 0
            : parseFloat(style.letterSpacing),
        opacity: style.opacity,
        width: text.width,
        height: text.height,
        below: text.top >= icon.bottom - 1,
        visible:
          element.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          }) &&
          node.parentElement.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          }),
      };
    });
    labels.push(value);
    close(
      value.size,
      12 * (width === 407 ? (width * 0.041026) / 16 : 1),
      `${name} label size`,
    );
    close(value.tracking, 0, `${name} label tracking`);
    assert.ok(
      value.visible &&
        value.opacity === "1" &&
        value.width > 0 &&
        value.height > 0 &&
        value.below,
      JSON.stringify(value),
    );
  }
  results.push({ width, labels });
  await page.screenshot({
    path: `${output}/navigation-${width}.png`,
    fullPage: true,
  });
}

test("KA-5 (OA-24/Mobile board): phone tabs and the collapsed rail keep visible 12px names below their icons", async () => {
  for (const width of [407, 1414]) {
    await checkNavigation(width);
  }
});
