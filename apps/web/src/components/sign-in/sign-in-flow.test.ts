import assert from "node:assert/strict";
import test from "node:test";

import {
  methodsDisabled,
  oauthErrorState,
  PRIVY_OAUTH_PROVIDERS,
  PRIVY_WALLET_LOGIN,
  SIGN_IN_IDLE,
  signInMessage,
  storedAttempt,
  waitingMethod,
  walletLoginErrorState,
  type SignInState,
} from "./sign-in-flow.ts";

/** Social UI-08 (FEATURE-MAP §8.2): the sign-in sheet's decisions. */

test("X and Google use OAuth and the Ethereum and Solana wallet button uses the existing Privy picker", () => {
  assert.deepEqual(PRIVY_OAUTH_PROVIDERS, { x: "twitter", google: "google" });
  assert.deepEqual(PRIVY_WALLET_LOGIN, { loginMethods: ["wallet"], walletChainType: "ethereum-and-solana" });
  assert.deepEqual(walletLoginErrorState("exited_auth_flow"), { status: "cancelled", method: "wallet" });
  assert.deepEqual(walletLoginErrorState("unknown_auth_error"), { status: "failed", method: "wallet" });
});

test("UI-08: pressing a method disables all methods and marks the one waiting; other states keep them usable", () => {
  for (const method of ["x", "google", "wallet"] as const) {
    const waiting: SignInState = { status: "waiting", method };
    assert.equal(methodsDisabled(waiting), true);
    assert.equal(waitingMethod(waiting), method);
    assert.equal(signInMessage(waiting), null);
  }
  for (const state of [SIGN_IN_IDLE, { status: "cancelled", method: "x" }, { status: "failed", method: "wallet" }, { status: "stalled" }] as SignInState[]) {
    assert.equal(methodsDisabled(state), false, state.status);
    assert.equal(waitingMethod(state), null);
  }
});

test("UI-08: an attempt that did not sign in says so: a cancel politely, a failure, a limit or a stall as an alert", () => {
  assert.equal(signInMessage(SIGN_IN_IDLE), null);
  assert.deepEqual(signInMessage({ status: "cancelled", method: "google" }), {
    text: "Sign-in was cancelled. You are still signed out. Code: request_cancelled.",
    alert: false,
  });
  assert.deepEqual(signInMessage({ status: "failed", method: "x" }), {
    text: "Sign-in did not finish. You are still signed out. Try again. Code: authentication_unavailable.",
    alert: true,
  });
  assert.equal(signInMessage({ status: "rate-limited", method: "wallet" })?.alert, true);
  assert.match(signInMessage({ status: "stalled" })!.text, /could not start/);
});

test("UI-08: Privy's OAuth errors: backing out is a cancel, anything else a failure; only our own attempt is answered", () => {
  for (const code of ["exited_auth_flow", "oauth_user_denied", "exited_link_flow"]) {
    assert.deepEqual(oauthErrorState("x", code), { status: "cancelled", method: "x" });
  }
  assert.deepEqual(oauthErrorState("google", "oauth_unexpected"), { status: "failed", method: "google" });
  assert.equal(storedAttempt("x"), "x");
  assert.equal(storedAttempt("google"), "google");
  for (const value of [null, "", "slush", "twitter", "X"]) assert.equal(storedAttempt(value), null, String(value));
});
