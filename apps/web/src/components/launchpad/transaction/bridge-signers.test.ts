import assert from "node:assert/strict";
import test from "node:test";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64, fromHex, toHex } from "@mysten/sui/utils";

import {
  connectDirectWalletSigner,
  connectPrivySigner,
  currentPrivySigner,
  currentDirectWalletSigner,
  type DirectWalletState,
  type PrivyState,
} from "./bridge-signers.ts";
import { createLaunchpadDAppKit, LAUNCHPAD_WALLET_STORAGE_KEY } from "./launchpad-dapp-kit.ts";

const walletKey = Ed25519Keypair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, index) => index + 11));
const privyKey = Ed25519Keypair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, index) => index + 41));

type Wallet = Readonly<{ name: string }>;
type Account = Readonly<{ address: string; chains: readonly string[] }>;

const EVERY_CHAIN = ["sui:mainnet", "sui:testnet", "sui:devnet", "sui:localnet"];

function directWallet(network: string, chains: readonly string[] = EVERY_CHAIN) {
  const connections: string[] = [];
  const state: DirectWalletState<Wallet, Account> = {
    network,
    account: null,
    wallet: null,
    wallets: [{ name: "Other wallet" }, { name: "Slush" }],
    async connect(wallet) {
      connections.push(wallet.name);
      return [{ address: walletKey.toSuiAddress(), chains }];
    },
    sign: async (transaction) => walletKey.signTransaction(fromBase64(transaction)),
  };
  return { state, connections };
}

const embeddedUser = {
  linkedAccounts: [
    {
      type: "wallet",
      chainType: "sui",
      connectorType: "embedded",
      walletClientType: "privy",
      imported: false,
      id: "wallet-1",
      recoveryMethod: "privy-v2",
      address: privyKey.toSuiAddress(),
      publicKey: privyKey.getPublicKey().toBase64(),
    },
  ],
};

function privy(network: string, session: Readonly<{ authenticated: boolean; user: typeof embeddedUser | null }>) {
  const calls: string[] = [];
  const state: PrivyState = {
    network,
    ready: async () => session,
    async login() {
      calls.push("login");
      return { linkedAccounts: [] };
    },
    async createWallet() {
      calls.push("create-wallet");
      return { user: embeddedUser };
    },
    signRawHash: async ({ hash }) => ({ signature: `0x${toHex(await privyKey.sign(fromHex(hash.slice(2))))}` }),
  };
  return { state, calls };
}

test("both signer kinds sign for the provider network", async () => {
  const wallet = await connectDirectWalletSigner(directWallet("mainnet").state);
  const embedded = await connectPrivySigner(privy("mainnet", { authenticated: true, user: embeddedUser }).state);
  assert.equal(wallet.chain, "sui:mainnet");
  assert.equal(embedded.chain, "sui:mainnet");
  assert.equal(wallet.kind, "wallet");
  assert.equal(embedded.kind, "privy");
});

test("the launchpad dApp Kit serves mainnet only", () => {
  const dAppKit = createLaunchpadDAppKit("mainnet");
  assert.deepEqual(dAppKit.networks, ["mainnet"]);
  assert.equal(dAppKit.stores.$currentNetwork.get(), "mainnet");
  assert.throws(() => createLaunchpadDAppKit("testnet"), /No Sui fullnode is configured for testnet/);
});

test("a wallet account without the provider network reports the chain it is on", async () => {
  const signer = await connectDirectWalletSigner(directWallet("testnet", ["sui:mainnet"]).state);
  assert.equal(signer.chain, "sui:mainnet");
});

test("the direct wallet prefers Slush, and an already connected account is reused", async () => {
  const fresh = directWallet("mainnet");
  const signer = await connectDirectWalletSigner(fresh.state);
  assert.deepEqual(fresh.connections, ["Slush"]);
  assert.equal(signer.label, "Slush");
  assert.equal(currentDirectWalletSigner(fresh.state), null, "nothing is current before a connection");
  const connected = directWallet("mainnet");
  const account = { address: walletKey.toSuiAddress(), chains: ["sui:mainnet"] };
  const state = { ...connected.state, account, wallet: { name: "Other wallet" } };
  assert.equal((await connectDirectWalletSigner(state)).label, "Other wallet");
  assert.deepEqual(connected.connections, []);
  assert.equal(currentDirectWalletSigner(state)?.chain, "sui:mainnet");
});

test("no installed wallet fails the connection with guidance", async () => {
  const { state } = directWallet("mainnet");
  await assert.rejects(connectDirectWalletSigner({ ...state, wallets: [] }), /No Sui wallet was found/);
});

test("Privy signs in and creates a Sui wallet only when needed", async () => {
  const signedOut = privy("mainnet", { authenticated: false, user: null });
  assert.equal((await connectPrivySigner(signedOut.state)).address, privyKey.toSuiAddress());
  assert.deepEqual(signedOut.calls, ["login", "create-wallet"]);
  const signedIn = privy("mainnet", { authenticated: true, user: embeddedUser });
  await connectPrivySigner(signedIn.state);
  assert.deepEqual(signedIn.calls, []);
});

test("a Privy signer carries the session's access token for same-origin outcome links; a direct wallet has none", async () => {
  const { state } = privy("mainnet", { authenticated: true, user: embeddedUser });
  const embedded = await connectPrivySigner({ ...state, accessToken: async () => "privy-access-token" });
  assert.equal(await embedded.accessToken?.(), "privy-access-token");
  assert.equal(currentPrivySigner({ ...state, accessToken: async () => null }, embeddedUser)?.accessToken !== undefined, true);
  assert.equal((await connectDirectWalletSigner(directWallet("mainnet").state)).accessToken, undefined);
});

test("the launchpad dApp Kit keeps its own storage key", () => {
  assert.equal(LAUNCHPAD_WALLET_STORAGE_KEY, "blast:launchpad:wallet:v1");
  assert.throws(() => createLaunchpadDAppKit("unknownnet"), /No Sui fullnode is configured for unknownnet/);
});

test("a direct wallet signs a Wallet Proof's personal message with its connected account; Privy authors use their session", async () => {
  const { state } = directWallet("mainnet");
  const signed: Array<{ message: string; account: string }> = [];
  const wallet = await connectDirectWalletSigner({
    ...state,
    async signPersonalMessage(message, account) {
      signed.push({ message: new TextDecoder().decode(message), account: account.address });
      return (await walletKey.signPersonalMessage(message)).signature;
    },
  });
  const message = new TextEncoder().encode("Blast wallet proof: not a transaction");
  const signature = await wallet.signPersonalMessage?.(message);
  assert.deepEqual(signed, [{ message: "Blast wallet proof: not a transaction", account: walletKey.toSuiAddress() }]);
  assert.equal(signature, (await walletKey.signPersonalMessage(message)).signature);
  assert.equal((await connectDirectWalletSigner(state)).signPersonalMessage, undefined, "a wallet state without message signing offers none");
  const embedded = await connectPrivySigner(privy("mainnet", { authenticated: true, user: embeddedUser }).state);
  assert.equal(embedded.signPersonalMessage, undefined);
});
