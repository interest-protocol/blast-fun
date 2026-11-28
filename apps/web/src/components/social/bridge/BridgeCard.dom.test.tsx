import assert from "node:assert/strict";
import test from "node:test";

import type { PrivyRuntime, PrivySession, PrivySourceWallets } from "#web/components/auth/privy-session.ts";

import { installTestDom, waitFor } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { PrivySessionContext, PrivySourceWalletsContext, privySessionValue } = await import("#web/components/auth/privy-session.ts");
const { PrivySourceWalletsStore } = await import("#web/components/presale/providers/privy-start.ts");
const { BridgeScreen } = await import("./BridgeScreen.tsx");
const { LOAD_FAILED_TEXT } = await import("./bridge-model.ts");

const BLAST = `0x${"ab".repeat(32)}`;
const SOURCE = `0x${"11".repeat(20)}`;

type Connects = Array<Parameters<PrivySourceWallets["connectWallet"]>[0]>;

/** Privy's connected wallets as the runtime publishes them: one EVM wallet on Base, or none. */
function sourceWallets(connects: Connects, evm: boolean): PrivySourceWallets {
  const wallet = {
    address: SOURCE,
    chainId: "eip155:8453",
    walletClientType: "metamask",
    connectedAt: 1,
    switchChain: async () => undefined,
    getEthereumProvider: async () => ({ request: async () => null }),
  };
  return {
    evm: (evm ? [wallet] : []) as unknown as PrivySourceWallets["evm"],
    solana: [],
    connectWallet: (options) => void connects.push(options),
    signSolanaTransaction: async () => { throw new Error("not used"); },
  };
}

/**
 * The page as `PrivySessionProvider` builds it: a session context and no
 * Privy provider anywhere above the card, which is the real `BridgeCard`
 * behind `BridgeScreen`'s lazy import.
 */
async function mount(load: () => Promise<PrivyRuntime>) {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const store = new PrivySourceWalletsStore();
  const session: PrivySession = privySessionValue(null, false, load, () => () => undefined);
  const client = createTestQueryClient();
  await act(async () => root.render(withQueryClient(client,
    <PrivySessionContext value={session}>
      <PrivySourceWalletsContext value={store}>
        <BridgeScreen blastAddress={BLAST} onSignIn={() => undefined} signedIn />
      </PrivySourceWalletsContext>
    </PrivySessionContext>,
  )));
  return {
    store,
    text: () => container.textContent ?? "",
    primary: () => container.querySelector<HTMLButtonElement>("button[data-ui-variant=primary]"),
    chain: () => container.querySelector<HTMLButtonElement>("[aria-label='From Base. Change chain']")!,
    send: () => container.querySelector<HTMLInputElement>("[inputmode=decimal]")!,
    loading: () => container.querySelector("[aria-label='Loading Bridge to Sui']") !== null,
    unmount: () => act(async () => root.unmount()),
  };
}

test("the card renders with no Privy provider above: skeleton until the runtime publishes wallets, then the form", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  let loads = 0;
  const card = await mount(() => {
    loads += 1;
    return new Promise(() => undefined);
  });
  try {
    await waitFor(() => card.loading(), "the skeleton while Privy starts");
    assert.ok(loads > 0, "opening Bridge starts Privy");
    assert.ok(card.store.wanted(), "the open card asks the runtime for Privy's wallets");
    assert.ok(!card.text().includes(LOAD_FAILED_TEXT), "no load failure before Privy is ready");

    const connects: Connects = [];
    await act(async () => card.store.publish(sourceWallets(connects, false)));
    const connect = await waitFor(() => card.primary()?.textContent === "Connect Base wallet" && card.primary(), "the form asks for the Base wallet");
    assert.ok(card.chain().compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING, "connect follows the source chain");
    assert.ok(connect.compareDocumentPosition(card.send()) & Node.DOCUMENT_POSITION_FOLLOWING, "connect comes before the send amount");
    assert.ok(!card.text().includes("25%"), "presets wait for the source wallet");
    await act(async () => connect.click());
    assert.deepEqual(connects, [{ walletChainType: "ethereum-only" }], "connect opens Privy's EVM picker");

    await act(async () => card.store.publish(sourceWallets(connects, true)));
    await waitFor(() => card.primary()?.textContent === "Bridge", "the connected wallet is the source");
    assert.deepEqual(errors, [], "nothing failed while rendering");
    await card.unmount();
    assert.ok(!card.store.wanted(), "a closed card stops the runtime's wallet hooks");
  } finally {
    console.error = original;
    await card.unmount();
  }
});

test("a Privy start that fails shows the load failure with a retry", async () => {
  const original = console.error;
  console.error = () => undefined;
  const card = await mount(async () => { throw new Error("Privy did not start. Try again."); });
  try {
    await waitFor(() => card.text().includes(LOAD_FAILED_TEXT), "the load failure");
  } finally {
    console.error = original;
    await card.unmount();
  }
});
