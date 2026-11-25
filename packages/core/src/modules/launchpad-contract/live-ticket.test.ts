import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_TICKET_TTL_MS, mintLiveTicket, verifyLiveTicket } from "./live-ticket.ts";

const SECRET = "s".repeat(48);
const ORIGIN = "https://blast.fun";

test("a live ticket verifies once for its origin and only until it expires", () => {
  const now = 1_790_000_000_000;
  const minted = mintLiveTicket(SECRET, ORIGIN, now);
  assert.deepEqual(verifyLiveTicket(SECRET, minted.ticket, ORIGIN, now), { nonce: minted.nonce, expiresAtMs: now + LIVE_TICKET_TTL_MS, origin: ORIGIN });
  assert.equal(verifyLiveTicket(SECRET, minted.ticket, ORIGIN, now + LIVE_TICKET_TTL_MS), null, "expired");
  assert.equal(verifyLiveTicket(SECRET, minted.ticket, "https://evil.test", now), null, "origin bound");
  assert.equal(verifyLiveTicket("t".repeat(48), minted.ticket, ORIGIN, now), null, "other secret");
  const [payload, mac] = minted.ticket.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, exp: now + 10 * LIVE_TICKET_TTL_MS, n: minted.nonce, o: ORIGIN })).toString("base64url");
  assert.equal(verifyLiveTicket(SECRET, `${forged}.${mac}`, ORIGIN, now), null, "payload swap");
  assert.equal(verifyLiveTicket(SECRET, `${payload}.${mac!.slice(0, -1)}${mac!.endsWith("A") ? "B" : "A"}`, ORIGIN, now), null);
  for (const junk of ["", ".", "a.b", `${payload}`, `${"x".repeat(300)}.${mac}`]) assert.equal(verifyLiveTicket(SECRET, junk, ORIGIN, now), null);
});
