import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { HomeHolderPosition, HomeHoldersPage } from "@blast/core/modules/social/contracts/coin-market.ts";

import { installTestDom } from "../../../../../../test/fixtures/social/test-dom.ts";
import { handClock } from "../../../../../../test/fixtures/workspace/live-clock.ts";
installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WorkspaceLiveProvider } = await import("../live-clock");
const { HolderPositions } = await import("./CoinFocusContext");
const { holderRows } = await import("./holder-rows");

const COIN = "0x2::wal::WAL";
const account = (callsign: string, why?: string | null): HomeHolderPosition => ({
  actor: { type: "account", callsign, display_name: callsign, avatar_url: null, x_handle: null, verified: false, path: `/@${callsign}` },
  balance: "30000000000000", share_bps: 100, value_usd: "12380.00", average_entry_usd: "0.3086",
  basis_usd: "9260.00", basis_complete: true, pnl_usd: "3120.00", pnl_multiple: "1.3400", why,
});
const wallet: HomeHolderPosition = {
  actor: { type: "address", address: `0x${"ab".repeat(32)}`, short: "0xabab…abab" },
  balance: "1000000000", share_bps: 1, value_usd: null, average_entry_usd: null, basis_usd: null, basis_complete: true, pnl_usd: null, pnl_multiple: null, why: null,
};
const kenji = account("kenji", "Storage demand from AI agents is only starting");
const ana = account("ana", null);
const theo = account("theo", "Mainnet usage keeps climbing");

test("the holders' filters: With thesis keeps the holders with a why, Following only the accounts followed, each empty state names what emptied it", () => {
  const follows = (callsign: string) => callsign === "kenji" || callsign === "ana";
  const shown = (holders: readonly HomeHolderPosition[], filters: Parameters<typeof holderRows>[1]) => {
    const { rows, empty } = holderRows(holders, filters);
    return empty ?? rows.map((row) => row.actor.type === "account" ? row.actor.callsign : "wallet");
  };
  const page = [kenji, ana, wallet, theo, account("luca")];
  assert.deepEqual(shown(page, { follows: null, withThesis: false }), ["kenji", "ana", "wallet", "theo", "luca"]);
  assert.deepEqual(shown(page, { follows: null, withThesis: true }), ["kenji", "theo"]);
  assert.deepEqual(shown(page, { follows, withThesis: false }), ["kenji", "ana"]);
  assert.deepEqual(shown(page, { follows, withThesis: true }), ["kenji"]);
  assert.equal(shown([], { follows: null, withThesis: true }), "No indexed holders");
  assert.equal(shown([wallet, ana], { follows: null, withThesis: true }), "No holders with a thesis");
  assert.equal(shown([theo], { follows, withThesis: true }), "No one you follow holds this coin");
  assert.equal(shown([ana, theo], { follows, withThesis: true }), "None of the holders you follow has a thesis");
});

/** The table for one read of `holders` (`withThesis` set or not). */
async function mount(t: TestContext, holders: readonly HomeHolderPosition[], withThesis: boolean) {
  const page: HomeHoldersPage = { coin_type: COIN, presale_id: null, decimals: 9, price_usd: "0.41", price_as_of_ms: 1, holders, as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(page);
  const time = handClock();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  const asset = { network: "mainnet", coin_type: COIN } as Parameters<typeof HolderPositions>[0]["asset"];
  await act(async () => {
    root.render(<WorkspaceLiveProvider clock={time.clock}><HolderPositions asset={asset} coin={null} visible withThesis={withThesis} /></WorkspaceLiveProvider>);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const cells = (role: string) => [...container.querySelectorAll("tr")].map((row) => [...row.querySelectorAll(role === "cell" ? "td" : "th")].map((cell) => `${cell.className}:${cell.textContent}`).at(-1));
  return { container, cells };
}

test("the Thesis column: a fifth column after Avg entry, the holder's why, an empty cell without one", async (t) => {
  const { container, cells } = await mount(t, [kenji, ana, wallet], false);
  const head = [...container.querySelectorAll("th")].map((cell) => cell.textContent);
  assert.deepEqual(head, ["Trader", "Position", "PnL", "Avg entry", "Thesis"]);
  assert.equal(container.querySelector("table")?.className, "holderTable table");
  assert.deepEqual(cells("cell").slice(1), ["thesis:Storage demand from AI agents is only starting", "thesis:", "thesis:"]);
});

test("With thesis lists only the holders with a why, and says so when none has one", async (t) => {
  const { cells } = await mount(t, [kenji, ana, wallet, theo], true);
  assert.deepEqual(cells("cell").slice(1), ["thesis:Storage demand from AI agents is only starting", "thesis:Mainnet usage keeps climbing"]);
  const { container } = await mount(t, [ana, wallet], true);
  assert.equal(container.querySelector("table"), null);
  assert.match(container.querySelector('[role="status"]')?.textContent ?? "", /^No holders with a thesis$/);
});

