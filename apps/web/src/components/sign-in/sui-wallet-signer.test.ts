import assert from "node:assert/strict";
import test from "node:test";

import { getWalletUniqueIdentifier } from "@mysten/dapp-kit-react";
import { SLUSH_WALLET_NAME } from "@mysten/slush-wallet";
import {
  getWallets,
  ReadonlyWalletAccount,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
  type SuiSignTransactionFeature,
  type SuiSignPersonalMessageFeature,
  type WalletWithFeatures,
} from "@mysten/wallet-standard";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import { walletSessionSigner } from "../social/coins/signers-model.ts";
import { walletCommitSigner } from "../social/commit/commit-signers.ts";
import { forgetWalletConnection, socialDAppKit, subscribeSuiSignInWallets, suiWalletSigner } from "./sui-wallet-signer.ts";

const ADDRESS = normalizeSuiAddress("0xa");
const OTHER = normalizeSuiAddress("0xb");
const bytes = new Uint8Array([1, 2, 3]);

function walletFixture(
  name: string = SLUSH_WALLET_NAME,
  personalSigning = true,
  id = name === SLUSH_WALLET_NAME ? "com.mystenlabs.suiwallet" : `test:${name}`,
) {
  const account = (address: string) => new ReadonlyWalletAccount({
    address,
    publicKey: new Uint8Array(32),
    chains: ["sui:mainnet"],
    features: ["sui:signTransaction", "sui:signAndExecuteTransaction", "sui:signPersonalMessage"],
  });
  const primary = account(ADDRESS);
  const other = account(OTHER);
  let accounts = [primary, other];
  let connected = [primary];
  const listeners = new Set<() => void>();
  const signed: string[] = [];
  let connects = 0;
  /** What a silent connect answers: the accounts this wallet already authorized (none by default). */
  let remembered: typeof accounts = [];
  let silentRefusal: Error | null = null;
  let disconnects = 0;
  const wallet = {
    id,
    version: "1.0.0",
    name,
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains: ["sui:mainnet"],
    get accounts() { return accounts; },
    features: {
      "standard:connect": {
        version: "1.0.0",
        async connect(input?: { silent?: boolean }) {
          if (input?.silent) {
            if (silentRefusal) throw silentRefusal;
            return { accounts: remembered };
          }
          connects++;
          return { accounts: connected };
        },
      },
      "standard:disconnect": { version: "1.0.0", async disconnect() { disconnects++; remembered = []; } },
      "standard:events": {
        version: "1.0.0",
        on(_event, listener) {
          const notify = () => listener({ accounts });
          listeners.add(notify);
          return () => { listeners.delete(notify); };
        },
      },
      ...(personalSigning ? {
        "sui:signPersonalMessage": {
          version: "1.1.0" as const,
          async signPersonalMessage({ account, message }: Parameters<SuiSignPersonalMessageFeature["sui:signPersonalMessage"]["signPersonalMessage"]>[0]) {
            signed.push(account.address);
            return { bytes: toBase64(message), signature: "personal-signature" };
          },
        },
      } : {}),
      "sui:signTransaction": {
        version: "2.0.0",
        async signTransaction({ account, transaction }) {
          signed.push(account.address);
          return { bytes: await transaction.toJSON(), signature: "signature" };
        },
      },
    },
  } satisfies WalletWithFeatures<StandardConnectFeature & StandardDisconnectFeature & StandardEventsFeature & SuiSignTransactionFeature & Partial<SuiSignPersonalMessageFeature>>;
  const unregister = getWallets().register(wallet);
  const kit = socialDAppKit();
  const unsubscribe = kit.stores.$connection.subscribe(() => {});
  const uiWallet = kit.stores.$wallets.get().find((candidate) => getWalletUniqueIdentifier(candidate) === id);
  assert.ok(uiWallet);
  return {
    kit, uiWallet, primary, other, signed,
    connects: () => connects,
    disconnects: () => disconnects,
    remember(next: typeof accounts) { remembered = next; },
    refuseSilently(error: Error | null) { silentRefusal = error; },
    change(next: typeof accounts, returned = next) {
      accounts = next;
      connected = returned;
      for (const listener of listeners) listener();
    },
    cleanup() { unregister(); unsubscribe(); },
  };
}

test("Slush A → B → A signs with A even while dApp Kit still selects B", async (t) => {
  const f = walletFixture();
  t.after(f.cleanup);
  await f.kit.connectWallet({ wallet: f.uiWallet });
  f.change([f.other]);
  f.change([f.other, f.primary], [f.other]);
  assert.equal(f.kit.stores.$connection.get().account?.address, OTHER);
  assert.deepEqual(await walletCommitSigner(ADDRESS).signTransaction(bytes), {
    bytes: toBase64(bytes), signature: "signature",
  });
  assert.deepEqual(f.signed, [ADDRESS]);
  assert.equal(f.connects(), 1, "an authorized account needs no reconnection");
});

test("withdrawals also use the authorized account when another account is selected", async (t) => {
  const f = walletFixture();
  t.after(f.cleanup);
  f.change([f.other, f.primary], [f.other]);
  await f.kit.connectWallet({ wallet: f.uiWallet });
  const sign = t.mock.method(f.kit, "signTransaction", async (input: Parameters<typeof f.kit.signTransaction>[0]) => {
    assert.equal(input.account?.address, ADDRESS);
    assert.equal(input.transaction, toBase64(bytes));
    return { bytes: toBase64(bytes), signature: "withdraw-signature" };
  });
  const signer = walletSessionSigner(ADDRESS);
  assert.equal(signer.fee, "wallet");
  if (signer.fee === "wallet") assert.deepEqual(await signer.signTransaction(bytes), { bytes: toBase64(bytes), signature: "withdraw-signature" });
  assert.equal(sign.mock.callCount(), 1);
  assert.equal(f.connects(), 1);
});

test("signing reconnects on demand without a Blast login or a prior wallet connection", async (t) => {
  const f = walletFixture();
  t.after(f.cleanup);
  f.change([f.other, f.primary]);
  assert.equal(f.kit.stores.$connection.get().account, null);
  await walletCommitSigner(ADDRESS).signTransaction(bytes);
  assert.deepEqual(f.signed, [ADDRESS]);
  assert.equal(f.kit.stores.$connection.get().account?.address, OTHER);
  assert.equal(f.connects(), 1);
});

test("Slush 2026-11-21: after a reload, an address the wallet already authorized signs with no connect popup", async (t) => {
  const f = walletFixture();
  t.after(async () => { await f.kit.disconnectWallet(); f.cleanup(); });
  f.change([f.other, f.primary]);
  f.remember([f.other, f.primary]);
  assert.equal(f.kit.stores.$connection.get().isConnected, false, "a reload leaves nothing connected");
  await walletCommitSigner(ADDRESS).signTransaction(bytes);
  assert.deepEqual(f.signed, [ADDRESS]);
  assert.equal(f.connects(), 0, "one popup (sign), not two (connect, then sign)");
  f.remember([f.other]);
  await f.kit.disconnectWallet();
  await walletCommitSigner(ADDRESS).signTransaction(bytes);
  assert.equal(f.connects(), 1, "an address the wallet does not remember still asks to connect");
});

test("a wallet that prompts on a silent connect and is refused is not asked again", async (t) => {
  const f = walletFixture();
  t.after(f.cleanup);
  f.refuseSilently(new Error("User rejected the request"));
  await assert.rejects(walletCommitSigner(ADDRESS).signTransaction(bytes), /rejected/);
  assert.equal(f.connects(), 0);
  assert.deepEqual(f.signed, []);
});

test("sign-out drops the connection sign-in kept, also after a reload", async (t) => {
  const f = walletFixture();
  t.after(f.cleanup);
  await forgetWalletConnection();
  assert.equal(f.disconnects(), 0, "nothing saved, nothing to drop");
  await f.kit.connectWallet({ wallet: f.uiWallet });
  await forgetWalletConnection();
  assert.equal(f.kit.stores.$connection.get().isConnected, false);
  assert.equal(f.disconnects(), 1);
  f.remember([f.primary]);
  await forgetWalletConnection();
  assert.equal(f.disconnects(), 2, "the session Slush saved before the reload is removed too");
  assert.equal(f.kit.stores.$connection.get().isConnected, false);
  assert.equal(f.connects(), 1, "with no popup");
});

test("equivalent address formats do not cause a mismatch", async (t) => {
  const f = walletFixture();
  t.after(f.cleanup);
  await f.kit.connectWallet({ wallet: f.uiWallet });
  const signer = walletCommitSigner("0xA");
  assert.equal(signer.address, ADDRESS);
  assert.equal(walletSessionSigner("0xA").address, ADDRESS);
  await signer.signTransaction(bytes);
  assert.deepEqual(f.signed, [ADDRESS]);
  assert.equal(f.connects(), 1);
});

test("an account not authorized by Slush is refused before signing", async (t) => {
  const f = walletFixture();
  t.after(f.cleanup);
  f.change([f.other]);
  await f.kit.connectWallet({ wallet: f.uiWallet });
  await assert.rejects(walletCommitSigner(ADDRESS).signTransaction(bytes), /Slush has not authorized/);
  const signer = walletSessionSigner(ADDRESS);
  if (signer.fee === "wallet") await assert.rejects(signer.signTransaction(bytes), /Slush has not authorized/);
  assert.deepEqual(f.signed, []);
});

for (const name of ["Nightly", "Scallop Wallet", "Mahalo", "OKX Wallet"]) {
  test(`${name} signs in and reconnects for commits and withdrawals using its authorized account`, async (t) => {
    const stored = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    } });
    t.after(() => { Reflect.deleteProperty(globalThis, "localStorage"); });
    const f = walletFixture(name);
    t.after(async () => { await f.kit.disconnectWallet(); f.cleanup(); });
    const signer = suiWalletSigner(f.uiWallet);
    assert.equal(await signer.connect(), ADDRESS);
    assert.equal(await signer.signPersonalMessage("challenge"), "personal-signature");
    await signer.disconnect();
    assert.equal(f.kit.stores.$connection.get().isConnected, false);
    assert.equal(stored.get(`blast:social:sign-in:v1:wallet-id:${ADDRESS}`), getWalletUniqueIdentifier(f.uiWallet));
    f.change([f.other, f.primary], [f.other, f.primary]);
    await walletCommitSigner(ADDRESS).signTransaction(bytes);
    assert.equal(f.kit.stores.$connection.get().wallet?.name, name);
    const withdrawal = walletSessionSigner(ADDRESS);
    if (withdrawal.fee === "wallet") await withdrawal.signTransaction(bytes);
    assert.deepEqual(f.signed, [ADDRESS, ADDRESS, ADDRESS]);
    await f.kit.disconnectWallet();
    stored.set(`blast:social:sign-in:v1:wallet:${OTHER}`, name);
    await walletCommitSigner(OTHER).signTransaction(bytes);
    assert.equal(f.kit.stores.$connection.get().wallet?.name, name, "an existing name-only choice still works");
    f.change([f.other]);
    await assert.rejects(walletCommitSigner(ADDRESS).signTransaction(bytes), /has not authorized/);
    assert.deepEqual(f.signed, [ADDRESS, ADDRESS, ADDRESS, OTHER]);
  });
}

test("wallets with the same name reconnect by the saved wallet ID", async (t) => {
  const first = walletFixture("Shared Wallet", true, "test:first");
  const chosen = walletFixture("Shared Wallet", true, "test:chosen");
  const address = normalizeSuiAddress("0xc");
  const { chains, features, publicKey } = chosen.primary;
  const account = new ReadonlyWalletAccount({ address, chains, features, publicKey });
  chosen.change([account]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === `blast:social:sign-in:v1:wallet-id:${address}` ? "test:chosen" : null,
  } });
  t.after(async () => {
    await chosen.kit.disconnectWallet();
    chosen.cleanup();
    first.cleanup();
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  await walletCommitSigner(address).signTransaction(bytes);
  assert.deepEqual(chosen.signed, [address]);
  assert.equal(first.connects(), 0);
});

test("discovery follows wallet registration and removal and skips wallets that cannot sign in", (t) => {
  const available: string[][] = [];
  const unsubscribe = subscribeSuiSignInWallets((wallets) => available.push(wallets.map(({ wallet }) => wallet.name)));
  t.after(unsubscribe);
  const transactionOnly = walletFixture("Transaction-only wallet", false);
  t.after(transactionOnly.cleanup);
  const okx = walletFixture("OKX Wallet");
  assert.ok(available.at(-1)?.includes("OKX Wallet"));
  assert.ok(!available.at(-1)?.includes("Transaction-only wallet"));
  okx.cleanup();
  assert.ok(!available.at(-1)?.includes("OKX Wallet"));
});

test("a refused storage write keeps the latest wallet choice for this page", async (t) => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => "Scallop Wallet",
    setItem: () => { throw new Error("Storage is full"); },
  } });
  t.after(() => { Reflect.deleteProperty(globalThis, "localStorage"); });
  const f = walletFixture("Nightly");
  t.after(async () => { await f.kit.disconnectWallet(); f.cleanup(); });
  const signer = suiWalletSigner(f.uiWallet);
  await signer.connect();
  await signer.disconnect();
  await walletCommitSigner(ADDRESS).signTransaction(bytes);
  assert.equal(f.kit.stores.$connection.get().wallet?.name, "Nightly");
  assert.deepEqual(f.signed, [ADDRESS]);
});
