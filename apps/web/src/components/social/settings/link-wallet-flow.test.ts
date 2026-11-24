import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
afterEach(() => mock.restoreAll());

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";

import {
  isRejection,
  LINK_COPY,
  LINK_MESSAGES,
  LINK_WALLETS,
  walletMonogram,
  runWalletLink,
  WalletNotInstalledError,
  type WalletAdapter,
} from "./link-wallet-flow.ts";

function linkWallet({ fetch, ...input }: Parameters<typeof runWalletLink>[0] & Readonly<{ fetch: typeof globalThis.fetch }>) {
  mock.method(globalThis, "fetch", fetch);
  return runWalletLink(input);
}

const keypair = Ed25519Keypair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, index) => index + 9));
const ADDRESS = keypair.toSuiAddress();
const CHALLENGE = { challenge_id: "11111111-1111-4111-8111-111111111111", address: ADDRESS, message: "BLAST.FUN wallet verification\nNonce: x", expires_at_ms: 1 };
const SLUSH = LINK_WALLETS[0];
const SUIET = LINK_WALLETS[1];
const token = async () => "tok";

type Reply = Readonly<{ status: number; body: unknown; headers?: HeadersInit }>;

function server(challenge: Reply, link: Reply = { status: 201, body: { wallet: { address: ADDRESS, kind: "slush", linked_at_ms: 7 } } }) {
  const sent: Array<{ url: string; body: unknown }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    const reply = url.endsWith("/challenge") ? challenge : link;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

function adapter(overrides: Partial<{ connect: WalletAdapter["connect"]; sign: (message: Uint8Array) => Promise<string> }> = {}) {
  const calls = { connect: [] as string[], released: 0 };
  const value: WalletAdapter = {
    async connect(name) {
      calls.connect.push(name);
      if (overrides.connect) return overrides.connect(name);
      return {
        address: ADDRESS,
        sign: overrides.sign ?? (async (message) => (await keypair.signPersonalMessage(message)).signature),
      };
    },
    async release() {
      calls.released += 1;
    },
  };
  return { calls, value };
}

test("UI-07 (§14.3): the supported Sui wallets and words", () => {
  assert.deepEqual(LINK_WALLETS.map((wallet) => [wallet.name, walletMonogram(wallet.name), wallet.kind]), [
    ["Slush", "S", "slush"],
    ["Suiet", "S", "external"],
    ["Phantom", "P", "external"],
    ["Nightly", "N", "external"],
    ["Scallop", "S", "external"],
    ["Mahalo", "M", "external"],
  ]);
  assert.equal(LINK_COPY.title, "Link a Sui wallet");
  assert.equal(LINK_COPY.lead, "You'll sign one message. Nothing is sent and it costs no gas.");
  assert.equal(LINK_COPY.signing("Slush"), "Sign in Slush");
});

test("T-017 (UI): connect, challenge, sign the challenge's exact text as a personal message, link", async () => {
  const api = server({ status: 201, body: CHALLENGE });
  const wallet = adapter();
  const outcome = await linkWallet({ choice: SLUSH, adapter: wallet.value, getAccessToken: token, fetch: api.fetch });
  assert.deepEqual(outcome, { status: "linked", wallet: { address: ADDRESS, kind: "slush", linked_at_ms: 7 }, name: "Slush" });
  assert.deepEqual(wallet.calls, { connect: ["Slush"], released: 1 });
  assert.deepEqual(api.sent.map((call) => call.url), ["/api/social/me/wallets/challenge", "/api/social/me/wallets"]);
  assert.deepEqual(api.sent[0]!.body, { address: ADDRESS });
  const link = api.sent[1]!.body as { signature: string; message: string; wallet: string; challenge_id: string; address: string };
  assert.equal(link.wallet, "slush");
  assert.equal(link.message, CHALLENGE.message);
  assert.equal(link.challenge_id, CHALLENGE.challenge_id);
  // The signature is over the challenge's UTF-8 text, as the server verifies it.
  const signer = await verifyPersonalMessageSignature(new TextEncoder().encode(CHALLENGE.message), link.signature, { offline: true });
  assert.equal(signer.toSuiAddress(), ADDRESS);
  // Another wallet links as external.
  const other = server({ status: 201, body: CHALLENGE });
  await linkWallet({ choice: SUIET, adapter: adapter().value, getAccessToken: token, fetch: other.fetch });
  assert.equal((other.sent[1]!.body as { wallet: string }).wallet, "external");
});

test("T-017 (UI): every way out is an outcome: not installed, cancelled, taken, bad signature, limited, session, failure", async () => {
  const ok = server({ status: 201, body: CHALLENGE });
  const missing = adapter({ connect: async (name) => Promise.reject(new WalletNotInstalledError(name)) });
  assert.deepEqual(await linkWallet({ choice: SUIET, adapter: missing.value, getAccessToken: token, fetch: ok.fetch }), {
    status: "failed",
    message: "Suiet isn't installed in this browser. Install it, then try again. Code: request_failed.",
  });
  assert.equal(missing.calls.released, 1);
  assert.equal(ok.sent.length, 0);

  const closed = adapter({ connect: async () => Promise.reject(new Error("User rejected the request.")) });
  assert.deepEqual(await linkWallet({ choice: SLUSH, adapter: closed.value, getAccessToken: token, fetch: ok.fetch }), {
    status: "cancelled",
    message: `${LINK_MESSAGES.cancelled} Code: wallet_rejected.`,
  });
  const declined = adapter({ sign: async () => Promise.reject(Object.assign(new Error("nope"), { code: 4001 })) });
  assert.equal((await linkWallet({ choice: SLUSH, adapter: declined.value, getAccessToken: token, fetch: server({ status: 201, body: CHALLENGE }).fetch })).status, "cancelled");
  const broken = adapter({ sign: async () => Promise.reject(new Error("internal error")) });
  assert.deepEqual(await linkWallet({ choice: SLUSH, adapter: broken.value, getAccessToken: token, fetch: server({ status: 201, body: CHALLENGE }).fetch }), {
    status: "failed",
    message: `${LINK_MESSAGES.failed} Code: request_failed.`,
  });

  const taken = server({ status: 409, body: { error: { code: "wallet_taken", message: "private provider text" } }, headers: { "X-Request-ID": "wallet-ref-1" } });
  assert.deepEqual(await linkWallet({ choice: SLUSH, adapter: adapter().value, getAccessToken: token, fetch: taken.fetch }), {
    status: "failed",
    message: "That wallet belongs to another Blast account. Nothing was linked. Code: wallet_taken. Reference: wallet-ref-1.",
  });
  assert.equal(taken.sent.length, 1, "nothing is signed for a taken address");

  const invalid = server({ status: 201, body: CHALLENGE }, { status: 400, body: { error: { code: "invalid_signature", message: "x" } } });
  assert.equal((await linkWallet({ choice: SLUSH, adapter: adapter().value, getAccessToken: token, fetch: invalid.fetch })).status, "failed");
  const limited = (async () => new Response(JSON.stringify({ error: { code: "rate_limited", message: "x" } }), { status: 429, headers: { "retry-after": "600" } })) as unknown as typeof globalThis.fetch;
  assert.deepEqual(await linkWallet({ choice: SLUSH, adapter: adapter().value, getAccessToken: token, fetch: limited }), {
    status: "failed",
    message: "Too many tries. Try again in 10 min. Nothing was linked. Code: rate_limited.",
  });
  const ended = server({ status: 401, body: { error: { code: "unauthorized", message: "x" } } });
  assert.deepEqual(await linkWallet({ choice: SLUSH, adapter: adapter().value, getAccessToken: async () => null, fetch: ended.fetch }), {
    status: "failed",
    message: `${LINK_MESSAGES.session} Code: unauthorized.`,
  });
  const down = server({ status: 503, body: { error: { code: "service_unavailable", message: "x" } } });
  assert.deepEqual(await linkWallet({ choice: SLUSH, adapter: adapter().value, getAccessToken: token, fetch: down.fetch }), {
    status: "failed",
    message: `${LINK_MESSAGES.failed} Code: service_unavailable.`,
  });
  assert.equal(isRejection(new Error("Popup closed")), true);
  assert.equal(isRejection(new Error("timeout")), false);
});
