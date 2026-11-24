import assert from "node:assert/strict";
import test from "node:test";

import { signInHref } from "../components/social/sign-in-gate.ts";
import {
  allowedSignInNext,
  SIGN_IN_DEFAULT_NEXT,
  signInReturnPath,
} from "./sign-in-next.ts";

/** `next` as the sign-in page receives it: the value of the gate's link, decoded once. */
function nextFromGate(path: string): string | null {
  return new URL(signInHref(path), "https://www.blast.fun").searchParams.get(
    "next",
  );
}

test("T-042-AC-1: the social gate's next for / and /@kai is kept", () => {
  for (const path of ["/", "/@kai"]) {
    const next = nextFromGate(path);
    assert.equal(next, path);
    assert.equal(allowedSignInNext(next), path);
    assert.equal(signInReturnPath(next), path);
  }
});

test("bonding My launches sign-in returns to the catalog", () => {
  assert.equal(signInReturnPath(nextFromGate("/bonding")), "/bonding");
  assert.equal(allowedSignInNext("/bonding-admin"), null);
  assert.equal(allowedSignInNext("/bonding/other"), null);
});

test("OA-4: a profile rendered under /crew/kai (the rewrite target) returns to /@kai, its address", () => {
  assert.equal(nextFromGate("/crew/kai"), "/@kai");
  assert.equal(signInReturnPath(nextFromGate("/crew/kai")), "/@kai");
});

test("OA-4: /@<callsign> and paths under it are allowed; a bare /@ is refused", () => {
  for (const path of ["/@kai", "/@kai_01", "/@kai?tab=calls"])
    assert.equal(allowedSignInNext(path), path);
  for (const path of ["/@", "//@kai", "/@kai/../admin"])
    assert.equal(allowedSignInNext(path), null, path);
});

test("T-042-AC-1: / exactly and paths under /crew/ are allowed, with an optional query", () => {
  for (const path of [
    "/",
    "/crew/kai",
    "/crew/Kai_01",
    "/crew/kai/posts",
    "/crew/kai?tab=posts",
    "/?ref=x",
  ]) {
    assert.equal(allowedSignInNext(path), path, path);
  }
  assert.equal(
    allowedSignInNext("/crew/kai#bio"),
    "/crew/kai",
    "a fragment is dropped",
  );
});

test("the presale's /presale and /settings areas stay allowed", () => {
  for (const path of [
    "/presale",
    "/presale/0xabc",
    "/presale/0xabc?step=pay",
    "/settings",
    "/settings/wallets",
    "/create",
  ]) {
    assert.equal(allowedSignInNext(path), path, path);
  }
});

test("T-042-AC-1: //evil.example and /admin are refused and fall back to the default", () => {
  for (const raw of ["//evil.example", "/admin"]) {
    assert.equal(allowedSignInNext(raw), null, raw);
    assert.equal(signInReturnPath(raw), SIGN_IN_DEFAULT_NEXT, raw);
  }
  assert.equal(SIGN_IN_DEFAULT_NEXT, "/");
});

test("other paths, prefix look-alikes and an empty callsign are refused", () => {
  for (const raw of [
    "/admin/x",
    "/mission",
    "/team",
    "/feed",
    "/sign-in",
    "/api/social/me",
    "/crew",
    "/crew/",
    "/crew?x=1",
    "/crewkai",
    "/presalex",
    "/presale-evil",
    "/settingsx",
    "/settings-evil/x",
  ]) {
    assert.equal(allowedSignInNext(raw), null, raw);
  }
});

test("absolute, protocol-relative, relative and non-string values are refused", () => {
  for (const raw of [
    "https://evil.example/",
    "https://www.blast.fun/crew/kai",
    "http:/crew/kai",
    "javascript:alert(1)",
    "data:text/html,x",
    "//evil.example/crew/kai",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "crew/kai",
    "",
    " /crew/kai",
    undefined,
    null,
    ["/crew/kai"],
    ["/crew/kai", "/"],
  ]) {
    assert.equal(allowedSignInNext(raw), null, String(raw));
    assert.equal(signInReturnPath(raw), "/", String(raw));
  }
});

test("encoded and normalisation tricks are refused", () => {
  for (const raw of [
    "/%2Fevil.example",
    "/%2fevil.example",
    "/%5Cevil.example",
    "/%5cevil.example",
    "/crew/%2E%2E/admin",
    "/crew/%2e%2e/admin",
    "/crew/../admin",
    "/crew/./kai",
    "/crew/kai/..",
    "/presale/../admin",
    "/crew/%252Fevil",
    "/crew/kai\\..\\..\\admin",
    "/crew/k\tai",
    "/crew/k\nai",
    "/crew/kai\u0000",
    "/\t/evil.example",
    "/crew/kai x",
  ]) {
    assert.equal(allowedSignInNext(raw), null, JSON.stringify(raw));
  }
});
