import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";

import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
// The page calls this hook once per draw of its own body: a stub counts SaleView's renders.
const draws = { page: 0 };
(globalThis as unknown as { saleViewDraws: typeof draws }).saleViewDraws = draws;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "#web/components/blast-ui/use-tabbar-autohide.ts") {
      return { url: `data:text/javascript,${encodeURIComponent("export function useTabBarAutoHide() { globalThis.saleViewDraws.page += 1; }")}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { Profiler, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { fixtureDetail, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
const { SaleView } = await import("./SaleView");
const { SaleAside } = await import("./SaleAside");
hooks.deregister();

const SECOND = 1_000;

/** Meridian (open), ending `endsInMs` after the fixture's clock. */
function openSale(endsInMs: number): SocialPresaleDetail {
  const detail = fixtureDetail("mrdn");
  return { ...detail, presale: { ...detail.presale, end_ms: FIXTURE_NOW + endsInMs } };
}

async function mountSale(t: TestContext, detail: SocialPresaleDetail) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: FIXTURE_NOW });
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  draws.page = 0;
  const aside = { updates: 0 };
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  await act(async () => root.render(withQueryClient(client, <>
    <SaleView detail={detail} nowMs={FIXTURE_NOW} viewerEntry={null} />
    <Profiler id="aside" onRender={(_id, phase) => { if (phase !== "mount") aside.updates += 1; }}>
      <SaleAside detail={detail} kit={null} nowMs={FIXTURE_NOW} />
    </Profiler>
  </>)));
  const pass = (ms: number) => act(async () => { t.mock.timers.tick(ms); });
  const text = (selector: string) => container.querySelector(selector)?.textContent ?? "";
  return { aside, pass, text };
}

test("on a quiet open sale, a second redraws the countdown and not the page", async (t) => {
  const page = await mountSale(t, openSale(5 * 60 * SECOND + 30 * SECOND));
  const mounted = draws.page;
  assert.equal(page.text("[data-raise-fact='Ends in'] b"), "5m 30s");
  const shown: string[] = [];
  for (let second = 1; second <= 10; second++) {
    await page.pass(SECOND);
    shown.push(page.text("[data-raise-fact='Ends in'] b"));
  }
  assert.deepEqual(shown, ["5m 29s", "5m 28s", "5m 27s", "5m 26s", "5m 25s", "5m 24s", "5m 23s", "5m 22s", "5m 21s", "5m 20s"]);
  t.diagnostic(`SaleView renders in 10 s: ${draws.page - mounted}; SaleAside commits: ${page.aside.updates}`);
  assert.equal(draws.page - mounted, 0, "the page body does not redraw while only the countdown moves");
  assert.equal(page.aside.updates, 0, "the right column does not redraw either");
});

test("the page and its side box close within a second of the sale's end", async (t) => {
  const page = await mountSale(t, openSale(3 * SECOND));
  const status = () => page.text(".sale-status");
  const box = () => page.text(".side-box .side-h h2");
  assert.equal(status(), "Live");
  assert.equal(box(), "Blast");
  await page.pass(3 * SECOND - 1);
  assert.equal(status(), "Live", "still open a moment before the end");
  await page.pass(1);
  assert.equal(status(), "Closed");
  assert.equal(box(), "Closed");
  assert.doesNotMatch(page.text("[data-sale-page]"), /Ends in/);
});

test("an upcoming sale keeps waiting for the server after its start time passes", async (t) => {
  const detail = fixtureDetail("mrdn");
  const pending: SocialPresaleDetail = { ...detail, presale: { ...detail.presale, phase: "pending", start_ms: FIXTURE_NOW + 2 * SECOND, opened_ms: null } };
  const page = await mountSale(t, pending);
  const before = page.text(".sale-status");
  await page.pass(10 * SECOND);
  assert.equal(page.text(".sale-status"), before);
  assert.doesNotMatch(page.text(".side-box .side-h h2"), /Closed/);
});
