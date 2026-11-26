import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { SocialViewerProvider } = await import("#web/components/social/SignInGate.tsx");
const { useViewerPresales } = await import("./presales-client");
const { SaleTransition } = await import("./SaleTransition");
const { fixtureDetail } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");

test("migration masks both columns until the viewer allocation refreshes; ordinary updates stay visible", async (t) => {
  const client = createTestQueryClient();
  const base = fixtureDetail("kstl").presale;
  const key = queryKeys.me.presaleViewer([base.presale_id]);
  client.setQueryData(key, { presales: {} });
  let answer!: (response: Response) => void;
  let reads = 0;
  const before = globalThis.fetch;
  globalThis.fetch = (async () => { reads += 1; return new Promise<Response>((resolve) => { answer = resolve; }); }) as typeof fetch;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); globalThis.fetch = before; });
  function Allocation() {
    useViewerPresales([base.presale_id]);
    return <button>Claim tokens</button>;
  }
  const render = (phase: typeof base.phase, price_usd = base.price_usd) => root.render(withQueryClient(client,
    <SocialViewerProvider signedIn callsign="kai">
      <SaleTransition sale={{ ...base, phase, price_usd }}><b>{phase}</b></SaleTransition>
      <SaleTransition aside sale={{ ...base, phase, price_usd }}><Allocation /></SaleTransition>
    </SocialViewerProvider>));
  await act(async () => render("open"));
  assert.equal(reads, 0);
  await act(async () => render("trading"));
  assert.equal(reads, 1, "both columns share the allocation read");
  assert.equal(container.querySelectorAll('[data-sale-transition="loading"]').length, 2);
  assert.ok(container.querySelector(".sale-transition-content[inert]"));
  assert.match(container.textContent!, /Preparing trading and your claim/);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
  assert.equal(container.querySelectorAll('[data-sale-transition="loading"]').length, 2, "a slow allocation stays behind the skeleton");
  await act(async () => { answer(Response.json({ presales: {}, rows: null })); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(container.querySelectorAll('[data-sale-transition="ready"]').length, 2);
  assert.equal(container.querySelector("[inert]"), null);
  await act(async () => render("trading", "0.003"));
  assert.equal(container.querySelector("[aria-busy]"), null);
  assert.equal(reads, 1, "a market price update does not restart the transition");
});
