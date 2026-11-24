import assert from "node:assert/strict";
import test from "node:test";

import {
  endWalletSession,
  hasWalletSessionHint,
  isWalletRejection,
  signInWithWallet,
  type WalletSigner,
} from "./wallet-sign-in-client.ts";

/** Social UI-08: the browser side of Slush sign-in, over a stub wallet and a stub fetch. */

const ADDRESS = `0x${"ab".repeat(32)}`;
const CHALLENGE = { challenge_id: "00000000-0000-4000-8000-000000000001", message: "BLAST.FUN wallet verification\n…", expires_at_ms: 1 };

type Call = Readonly<{ path: string; method: string; credentials: RequestCredentials | undefined; body: unknown }>;

function stubFetch(answers: Readonly<Record<string, Response | (() => Response) | Error>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, credentials: init.credentials, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[`${method} ${path}`];
    if (answer instanceof Error) throw answer;
    if (!answer) return new Response(null, { status: 404 });
    return typeof answer === "function" ? answer() : answer;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function signer(overrides: Partial<WalletSigner> = {}) {
  const events: string[] = [];
  const wallet: WalletSigner = {
    connect: async () => {
      events.push("connect");
      return ADDRESS;
    },
    signPersonalMessage: async (message) => {
      events.push(`sign:${message === CHALLENGE.message}`);
      return "c2lnbmF0dXJl";
    },
    disconnect: async () => {
      events.push("disconnect");
    },
    ...overrides,
  };
  return { wallet, events };
}

const json = (status: number, body: unknown) => () => Response.json(body, { status });

test("UI-08: Slush sign-in connects, signs the server's challenge and proves it, same-origin, and keeps the connection for trades", async () => {
  const { calls, fetchImpl } = stubFetch({
    "POST /api/social/sign-in/challenge": json(200, CHALLENGE),
    "POST /api/social/sign-in/session": json(201, { expires_at_ms: 2 }),
  });
  const { wallet, events } = signer();
  assert.equal(await signInWithWallet(wallet, fetchImpl), "signed-in");
  assert.deepEqual(events, ["connect", "sign:true"], "Slush 2026-11-21: the first trade then opens one popup, not two");
  assert.deepEqual(calls, [
    { path: "/api/social/sign-in/challenge", method: "POST", credentials: "same-origin", body: { address: ADDRESS } },
    {
      path: "/api/social/sign-in/session",
      method: "POST",
      credentials: "same-origin",
      body: { challenge_id: CHALLENGE.challenge_id, address: ADDRESS, message: CHALLENGE.message, signature: "c2lnbmF0dXJl" },
    },
  ]);
});

test("a malformed sign-in challenge ends the flow before requesting a signature", async () => {
  const { calls, fetchImpl } = stubFetch({
    "POST /api/social/sign-in/challenge": json(200, { ...CHALLENGE, challenge_id: "invalid" }),
  });
  const { wallet, events } = signer();

  assert.equal(await signInWithWallet(wallet, fetchImpl), "failed");
  assert.deepEqual(events, ["connect", "disconnect"]);
  assert.equal(calls.length, 1);
});

test("UI-08: closing Slush or refusing to sign is a cancel; a refused proof or an outage a failure; 429 a limit", async () => {
  const ok = { "POST /api/social/sign-in/challenge": json(200, CHALLENGE) };
  const rejected = signer({ connect: async () => Promise.reject(new Error("User rejected the request.")) });
  assert.equal(await signInWithWallet(rejected.wallet, stubFetch(ok).fetchImpl), "cancelled");
  assert.deepEqual(rejected.events, [], "nothing to disconnect before a connection");
  assert.equal(await signInWithWallet(signer({ connect: async () => Promise.reject(new Error("boom")) }).wallet, stubFetch(ok).fetchImpl), "failed");

  const declined = signer({ signPersonalMessage: async () => Promise.reject(new Error("Signature declined")) });
  assert.equal(await signInWithWallet(declined.wallet, stubFetch(ok).fetchImpl), "cancelled");
  assert.deepEqual(declined.events, ["connect", "disconnect"]);

  const refused = stubFetch({ ...ok, "POST /api/social/sign-in/session": json(400, { error: { code: "wallet_proof_invalid" } }) });
  const refusedProof = signer();
  assert.equal(await signInWithWallet(refusedProof.wallet, refused.fetchImpl), "failed");
  assert.deepEqual(refusedProof.events, ["connect", "sign:true", "disconnect"], "a failed sign-in keeps no connection");
  assert.equal(await signInWithWallet(signer().wallet, stubFetch({ "POST /api/social/sign-in/challenge": json(429, {}) }).fetchImpl), "rate-limited");
  assert.equal(
    await signInWithWallet(signer().wallet, stubFetch({ ...ok, "POST /api/social/sign-in/session": json(429, {}) }).fetchImpl),
    "rate-limited",
  );
  assert.equal(await signInWithWallet(signer().wallet, stubFetch({ "POST /api/social/sign-in/challenge": new TypeError("offline") }).fetchImpl), "failed");
});

test("UI-08: sign-out deletes the session; an outage reports false, never a throw", async () => {
  const out = stubFetch({ "DELETE /api/social/sign-in/session": json(200, { signed_in: false }) });
  assert.equal(await endWalletSession(out.fetchImpl), true);
  assert.equal(out.calls[0]?.method, "DELETE");
  assert.equal(out.calls[0]?.credentials, "same-origin");
  assert.equal(await endWalletSession(stubFetch({ "DELETE /api/social/sign-in/session": new TypeError("offline") }).fetchImpl), false);
});

test("UI-08: the hint cookie is read exactly; wallet refusals are recognised by their words", () => {
  assert.equal(hasWalletSessionHint("a=1; __Host-blast_wallet_hint=1; b=2"), true);
  assert.equal(hasWalletSessionHint("__Host-blast_wallet_hint=0"), false);
  assert.equal(hasWalletSessionHint("x__Host-blast_wallet_hint=1"), false);
  assert.equal(hasWalletSessionHint(""), false);
  for (const message of ["User rejected the request", "Request denied", "Popup closed", "cancelled", "declined"]) {
    assert.equal(isWalletRejection(new Error(message)), true, message);
  }
  assert.equal(isWalletRejection(new Error("Network error")), false);
});
