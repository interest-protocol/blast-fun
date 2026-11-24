import assert from "node:assert/strict";
import test from "node:test";

import { socialViewerProps } from "./social-account-client";

const getAccessToken = async () => "token";
const logout = async () => undefined;

test("the Privy session's access token, callsign and logout reach the viewer, so follows are authorized", () => {
  const props = socialViewerProps(
    { ready: true, authenticated: true, getAccessToken, logout },
    { status: "ready", account: { callsign: "kai" } } as never,
  );
  assert.equal(props.signedIn, true);
  assert.equal(props.callsign, "kai");
  assert.equal(props.getAccessToken, getAccessToken);
  assert.equal(props.signOut, logout);
});

test("before Privy is ready, or signed out, the viewer is a visitor with no callsign", () => {
  for (const session of [{ ready: false, authenticated: true }, { ready: true, authenticated: false }]) {
    const props = socialViewerProps({ ...session, getAccessToken, logout }, { status: "signed_out", account: null });
    assert.equal(props.signedIn, false);
    assert.equal(props.callsign, null);
  }
});

test("OA-16: a wallet session signs the viewer in without Privy, until me refuses it", async () => {
  const privy = { ready: true, authenticated: false, getAccessToken: async () => { throw new Error("Privy provider missing"); }, logout };
  const walletReady = socialViewerProps(privy, { status: "ready", account: { callsign: "slush_pilot" } } as never, true);
  assert.equal(walletReady.signedIn, true);
  assert.equal(walletReady.callsign, "slush_pilot");
  assert.equal(await walletReady.getAccessToken(), null, "wallet credentials do not depend on Privy");
  assert.equal(socialViewerProps(privy, { status: "loading", account: null }, true).signedIn, true);
  assert.equal(socialViewerProps(privy, { status: "signed_out", account: null }, true).signedIn, false, "me refused the cookie");
  assert.equal(socialViewerProps(privy, { status: "ready", account: null }, false).signedIn, false);
});

test("restoring Privy or a wallet cookie is pending, and a backend refusal settles signed out", () => {
  for (const wallet of [false, true]) {
    assert.equal(socialViewerProps({ ready: false, authenticated: false, getAccessToken, logout }, { status: "loading", account: null }, wallet).sessionPending, true);
  }
  const refused = socialViewerProps({ ready: true, authenticated: true, getAccessToken, logout }, { status: "signed_out", account: null });
  assert.equal(refused.sessionPending, false);
  assert.equal(refused.signedIn, false);
});
