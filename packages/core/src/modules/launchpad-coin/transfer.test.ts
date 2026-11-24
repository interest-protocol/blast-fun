import assert from "node:assert/strict";
import test from "node:test";

import { parseCoinPageTransfer } from "./transfer.ts";
import { encodeCoinWire } from "./wire.ts";

const launchId = `0x${"a".repeat(64)}`;
const envelope = { read: { kind: "coin", page: { launchId, confirmed: true, tradable: false } }, browserMarket: null, explorer: null };

test("coin reads accept the previous envelope and the optional published launch details", () => {
  assert.equal(parseCoinPageTransfer(encodeCoinWire(envelope), launchId).details, undefined);
  const details = { tagline: "A little bird", iconUrl: "https://example.com/bird.webp", cover: { url: "https://example.com/cover.webp", width: 1536, height: 512 }, links: [{ label: "Docs", url: "https://example.com/docs" }] };
  assert.deepEqual(parseCoinPageTransfer(encodeCoinWire({ ...envelope, details }), launchId).details, details);
  assert.throws(() => parseCoinPageTransfer(encodeCoinWire(envelope), `0x${"b".repeat(64)}`));
});

test("invalid launch metadata never reaches a page as links or image sources", () => {
  for (const details of [
    { tagline: "Bird", iconUrl: "http://example.com/bird.webp", cover: null, links: [] },
    { tagline: "Bird", cover: null, links: [{ label: "Docs", url: "javascript:alert(1)" }] },
    { tagline: "Bird", cover: { url: "data:image/svg+xml,", width: 1, height: 1 }, links: [] },
  ]) assert.throws(() => parseCoinPageTransfer(encodeCoinWire({ ...envelope, details }), launchId));
});

test("R3-23: a verified curve coin's read carries verifiedTeam: true; any other value or stray key is refused", () => {
  assert.equal(parseCoinPageTransfer(encodeCoinWire({ ...envelope, verifiedTeam: true }), launchId).verifiedTeam, true);
  assert.equal(parseCoinPageTransfer(encodeCoinWire({ ...envelope, details: null, verifiedTeam: true }), launchId).verifiedTeam, true);
  for (const extra of [{ verifiedTeam: false }, { verifiedTeam: "true" }, { verified: true }])
    assert.throws(() => parseCoinPageTransfer(encodeCoinWire({ ...envelope, ...extra }), launchId));
});
