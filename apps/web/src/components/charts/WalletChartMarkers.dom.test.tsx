import assert from "node:assert/strict";
import test from "node:test";
import type { PoolCandlePage } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";
import { walletMarkerBadges, walletMarkers } from "./wallet-markers.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { WalletChartMarkers } = await import("./WalletChartMarkers.tsx");
const { setDevicePref } = await import("#web/components/blast-ui/device-prefs.ts");

const seller = `0x${"11".repeat(32)}`;
const firstBuyer = `0x${"22".repeat(32)}`;
const chosenBuyer = `0x${"33".repeat(32)}`;
const page: PoolCandlePage = {
  source: "curve", venue: "blast_curve", poolKey: "blast_curve:0x1", interval: "1m", migration: null,
  candles: [{ bucketStart: 60_000, open: "1", high: "1", low: "1", close: "1", volumeQuote: 0n, volumeMeme: 0n, volumeUsd: null, buys: 2, sells: 1, trades: 3 }],
};
const trades = walletMarkers([
  { cursor: "1", address: seller, timestampMs: 80_000, poolKey: page.poolKey, side: "sell", labels: ["whale"] },
  { cursor: "2", address: firstBuyer, timestampMs: 89_000, poolKey: page.poolKey, side: "buy", labels: ["whale"] },
  { cursor: "3", address: chosenBuyer, timestampMs: 91_000, poolKey: page.poolKey, side: "buy", labels: ["deployer"] },
], page, bucket => bucket);
const badges = walletMarkerBadges(trades, 280, 140, 16, () => ({ x: 150, y: 65 }));

test("wallet marker activation opens the public profile or the chosen explorer account", async t => {
  const requests: { address: string; timestampMs: number }[][] = [];
  const profilePaths: string[] = [];
  const explorerDestinations: string[] = [];
  const router = { push: (path: string) => { profilePaths.push(path); } };
  const originalLocation = location;
  globalThis.location = { ...originalLocation, assign(destination) { explorerDestinations.push(String(destination)); } };
  let failLookup = false;
  let heldLookup: { signal: AbortSignal | null | undefined; finish: (response: Response) => void } | undefined;
  let holdLookup = false;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input), originalLocation.origin);
    assert.equal(url.pathname, "/api/social/home/trader-profiles");
    const wallets = JSON.parse(url.searchParams.get("traders")!);
    requests.push(wallets);
    const { address, timestampMs } = wallets[0];
    if (holdLookup) return new Promise<Response>(finish => { heldLookup = { signal: init?.signal, finish }; });
    if (failLookup) return new Response(null, { status: 503 });
    return Response.json({ [`${address}:${timestampMs}`]: address === seller ? { callsign: "trader", avatarUrl: null } : null });
  });
  const shell = dom.document.createElement("div");
  const node = dom.document.createElement("div");
  shell.setAttribute("data-blast-ui", "");
  shell.append(node);
  dom.document.body.append(shell);
  const root = createRoot(node);
  const button = (name: string) => shell.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;

  try {
    setDevicePref("explorer", "suivision");
    await act(async () => root.render(<AppRouterContext value={router as never}><WalletChartMarkers badges={badges} /></AppRouterContext>));
    assert.deepEqual(requests, [], "mounting both markers makes no profile lookup");
    await act(async () => button("Open seller wallet 0x1111…1111").click());
    assert.deepEqual(profilePaths, ["/@trader"]);
    assert.deepEqual(explorerDestinations, [], "an internal profile keeps the current document");
    assert.deepEqual(requests, [[{ address: seller, timestampMs: 80_000 }]]);

    await act(async () => button("Choose from 2 buyer wallets").click());
    assert.ok(shell.querySelector('[role="dialog"] h2')?.textContent === "Choose a wallet");
    assert.deepEqual(profilePaths, ["/@trader"], "opening the chooser doesn't pick a wallet");
    assert.deepEqual(explorerDestinations, []);
    assert.equal(requests.length, 1);
    assert.ok(button("0x2222…2222"));
    await act(async () => button("0x3333…3333").click());
    assert.equal(explorerDestinations.at(-1), `https://suivision.xyz/account/${chosenBuyer}`);
    assert.deepEqual(requests.at(-1), [{ address: chosenBuyer, timestampMs: 91_000 }]);

    const chooser = button("Choose from 2 buyer wallets");
    await act(async () => chooser.click());
    failLookup = true;
    await act(async () => button("Open seller wallet 0x1111…1111").click());
    assert.equal(explorerDestinations.at(-1), `https://suivision.xyz/account/${seller}`, "lookup failure still opens the selected wallet");
    assert.equal(requests.length, 3);

    holdLookup = true;
    await act(async () => chooser.click());
    await act(async () => button("0x2222…2222").click());
    assert.equal(button("Opening wallet").getAttribute("aria-busy"), "true");
    await act(async () => button("0x3333…3333").click());
    assert.equal(requests.length, 4, "one selection is pending at a time");
    await act(async () => chooser.click());
    assert.equal(heldLookup?.signal?.aborted, true, "closing the chooser cancels its selection");
    await act(async () => heldLookup?.finish(Response.json({ [`${firstBuyer}:89000`]: null })));
    assert.equal(explorerDestinations.length, 2, "a dismissed selection never navigates");
    assert.deepEqual(profilePaths, ["/@trader"]);
  } finally {
    await act(async () => root.unmount());
    setDevicePref("explorer", "suiscan");
    globalThis.location = originalLocation;
    shell.remove();
  }
});
