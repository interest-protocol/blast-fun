import assert from "node:assert/strict";
import test from "node:test";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import type { ActionState } from "../transaction/action-machine";
import type { ActionController } from "../transaction/controller";
import type { VenueTradeInput } from "./venue-adapter";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import { CETUS_LAUNCH_ID, CETUS_MIGRATION_DIGEST, CETUS_POOL_ID, createVenueFixtureChain, VENUE_FIXTURE_MANIFEST } from "../../../../test/fixtures/launchpad/trade/venue-fixtures.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient } = await import("#web/lib/query/test-client.ts");
const { LaunchpadSignerProvider } = await import("../transaction/LaunchpadSignerProvider");
const { readVenueAvailability, readVenueRoute } = await import("./venue-route");
const { VenueTradeProvider } = await import("./VenueTradeProvider");
const { VenueTradeRail } = await import("./VenueTradeRail");

const NOW = 1_790_000_000_000;

test("an open review shows its quote expired within a second of the expiry, with nothing else changing", async (t) => {
  const chain = { client: createVenueFixtureChain().client, manifest: VENUE_FIXTURE_MANIFEST, mode: "non-production" as const };
  const locator = { launchId: CETUS_LAUNCH_ID, migrationDigest: CETUS_MIGRATION_DIGEST, poolKey: `cetus:${CETUS_POOL_ID}` };
  const route = await readVenueRoute(chain.client, defineBlastDeployment(VENUE_FIXTURE_MANIFEST), locator, NOW);
  const availability = await readVenueAvailability(chain, "cetus");
  const input: VenueTradeInput = { ...locator, direction: "buy", amount: "10", slippageBps: 50n };
  const review = { id: "review-1", facts: [], expiresAtMs: NOW + 1_500 };
  const state = { phase: "review", input, attempt: 1, review, changes: [] } as unknown as ActionState<VenueTradeInput>;
  const controller = (current: ActionState<VenueTradeInput>): ActionController<VenueTradeInput> => ({
    getState: () => current, subscribe: () => () => {}, onInvalidate: () => () => {},
    edit() {}, submit() {}, chooseSigner() {}, cancel() {}, approve() {}, recheck() {}, acknowledge() {},
  });
  const controllers = { buy: controller(state), sell: controller({ phase: "editing", input: { ...input, direction: "sell" }, attempt: 0, notice: null }) };

  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const client = createTestQueryClient();
  const container = dom.document.createElement("div");
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); });
  await act(async () => root.render(
    <QueryProvider client={client}>
      <LaunchpadSignerProvider kinds={["wallet", "privy"]} renderBridge={() => {}}>
        <VenueTradeProvider chain={chain} locator={locator} initialRoute={route} initialAvailability={availability} controllers={controllers} now={Date.now}>
          <VenueTradeRail />
        </VenueTradeProvider>
      </LaunchpadSignerProvider>
    </QueryProvider>,
  ));
  const pass = (ms: number) => act(async () => { t.mock.timers.tick(ms); });
  await pass(1_000);
  assert.match(container.textContent!, /Quote valid until/);
  assert.doesNotMatch(container.textContent!, /Get a fresh quote/);
  await pass(1_000);
  assert.match(container.textContent!, /This quote expired at .* Get a fresh quote/);
});
