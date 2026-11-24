import assert from "node:assert/strict";
import test from "node:test";

import {
  clearedWalletSessionCookies,
  createWalletSessionToken,
  readWalletSessionToken,
  walletSessionCookies,
  walletSessionTokenHash,
} from "./sessions.ts";

/** Social UI-08 (OA-16): the wallet session's token and cookies (no database). */


test("UI-08: session tokens are 256-bit, stored hashed, sent once in a __Host- HttpOnly SameSite=Strict cookie", () => {
  const token = createWalletSessionToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(createWalletSessionToken(), token);
  assert.match(walletSessionTokenHash(token), /^[0-9a-f]{64}$/);
  assert.deepEqual(walletSessionCookies(token, 60), [
    `__Host-blast_wallet=${token}; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Strict`,
    "__Host-blast_wallet_hint=1; Path=/; Max-Age=60; Secure; SameSite=Strict",
  ]);
  assert.throws(() => walletSessionCookies("short", 60), TypeError);
  assert.ok(clearedWalletSessionCookies().every((cookie) => cookie.includes("Max-Age=0")));

  const read = (cookie: string | null) =>
    readWalletSessionToken(new Request("https://blast.fun/", cookie === null ? {} : { headers: { cookie } }));
  assert.equal(read(`a=1; __Host-blast_wallet=${token}; b=2`), token);
  assert.equal(read(null), null);
  assert.equal(read("__Host-blast_wallet=short"), null);
  assert.equal(read(`__Host-blast_wallet=${token}; __Host-blast_wallet=${token}`), null, "a duplicated cookie is refused");
  assert.equal(read(`__Host-blast_wallet_hint=1`), null);
});
