import assert from "node:assert/strict";
import test from "node:test";
import { NO_COST_BASIS } from "@blast/core/modules/social/contracts/portfolio.ts";
import type { SocialMePresales } from "@blast/core/modules/social/contracts/profile-page.ts";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient } = await import("@tanstack/react-query");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { SocialViewerProvider } = await import("../social/SignInGate.tsx");
const { PresalesList } = await import("./PresalesList");
const { fixtureList, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
const now = FIXTURE_NOW;
const backedPresaleId = `0x${"b".repeat(64)}`;
const positions: SocialMePresales = {
  created: [], watchlist: [], coins: [], vestings: [], positions: [{
    presale: { presale_id: backedPresaleId, symbol: "MRDN", name: "Backed Meridian", icon_url: "", status: "open", venue: "cetus", start_ms: now - 60_000, end_ms: now + 3_600_000, fill_pct: 73, quote_symbol: "USDC", quote_decimals: 6, launched_ms: null, first_unlock_ms: null },
    committed_usd: "100.00", committed_atoms: "100000000", status: "open", claimed_tokens: null, refunded_usd: null, refunded_atoms: null, value_usd: null, multiple: null, ...NO_COST_BASIS,
  }],
};
const getAccessToken = async () => "test-access-token";

for (const scenario of ["visitor", "positions", "empty", "retry"] as const) {
  test(`Backed stays in Presales with usable navigation: ${scenario}`, async (t) => {
    window.history.replaceState(null, "", "/presale?view=backed");
    const previous = globalThis.fetch;
    let failed = scenario === "retry";
    let privateReads = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/me/presales")) {
        privateReads++;
        return failed ? Response.json({ error: { code: "service_unavailable" } }, { status: 503 }) : Response.json(scenario === "empty" ? { ...positions, positions: [] } : positions);
      }
      if (url.includes("/viewer")) return Response.json({ presales: {}, rows: null });
      return Response.json(fixtureList("live", "ending"));
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); globalThis.fetch = previous; });
    await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider signedIn={scenario !== "visitor"} callsign="kai" getAccessToken={getAccessToken}><PresalesList initial={null} nowMs={now} status="live" sort="ending" view="backed" /></SocialViewerProvider></QueryProvider>));
    const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    await settle();
    const select = (label: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="View"] button')].find(b => b.textContent === label)!.click());
    assert.equal(window.location.pathname, "/presale");
    assert.equal(container.querySelector('[aria-label="View"] button[aria-pressed="true"]')?.textContent, "Backed");
    assert.equal(container.querySelectorAll('[aria-label="View"] button').length, 3);
    assert.equal(container.querySelector('[href="/portfolio?tab=presales"]'), null);
    assert.equal(container.querySelector('[role="tablist"]'), null);
    if (scenario === "visitor") {
      assert.match(container.textContent!, /Sign in to see the presales you’ve backed/);
      assert.equal(privateReads, 0);
      assert.doesNotMatch(container.textContent!, /Backed Meridian/);
    } else if (scenario === "empty") {
      assert.match(container.textContent!, /No backed presales yet/);
    } else {
      if (scenario === "retry") {
        assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /couldn’t load/);
        failed = false;
        await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Try again")!.click());
        await settle();
        assert.equal(container.querySelector('[role="alert"]'), null);
      }
      assert.match(container.textContent!, /Backed Meridian/);
      assert.ok(container.querySelector(`a[href="/presale/${backedPresaleId}"]`));
    }
    await select("Browse"); await settle();
    assert.equal(window.location.pathname, "/presale");
    assert.equal(container.querySelector('[aria-label="View"] button[aria-pressed="true"]')?.textContent, "Browse");
    assert.ok(container.querySelector(".presale-grid a"), "Browse loads public rows after a direct Backed visit");
    await select("Backed"); await settle();
    assert.equal(new URLSearchParams(window.location.search).get("view"), "backed");
    await select("Calendar"); await settle();
    assert.equal(container.querySelector('[aria-label="View"] button[aria-pressed="true"]')?.textContent, "Calendar");
    assert.equal(window.location.pathname, "/presale");
    await act(async () => { window.history.replaceState(null, "", "/presale?view=backed"); window.dispatchEvent(new window.PopStateEvent("popstate")); });
    await settle();
    assert.equal(container.querySelector('[aria-label="View"] button[aria-pressed="true"]')?.textContent, "Backed");
  });
}
