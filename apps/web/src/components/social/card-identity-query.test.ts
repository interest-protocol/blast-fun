import assert from "node:assert/strict";
import test from "node:test";
import { createCardIdentityLoader } from "./card-identity-query";
import { cardIdentityCallsigns, isCardIdentity } from "@blast/core/modules/social/contracts/card-identity.ts";

const countdown = { crew: 123, edition: "countdown", published_card_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };

test("card identity preserves the original allocation, including one-of-one exceptions", () => {
  assert.ok(isCardIdentity(countdown));
  assert.ok(isCardIdentity({ crew: 727, edition: "blast-launch-day", published_card_id: null }));
  for (const value of [{ ...countdown, edition: "pearl" }, { ...countdown, crew: 0 }, { ...countdown, crew: 1.5 }, { ...countdown, published_card_id: "https://private.blob/card" }, {}, null]) assert.equal(isCardIdentity(value), false);
  assert.deepEqual(cardIdentityCallsigns(new URL("https://blast.fun?callsigns=nova,kai,kai")), ["kai", "nova"]);
  for (const query of ["", "callsigns=kai&callsigns=nova", "callsigns=kai,<svg>", `callsigns=${Array(51).fill("kai").join(",")}`]) assert.equal(cardIdentityCallsigns(new URL(`https://blast.fun?${query}`)), null);
});

test("a render's repeated avatars share a sorted, bounded batch and retain non-card users", async () => {
  const batches: string[][] = [];
  const request: typeof fetch = async (input) => {
    const names = new URL(String(input), "https://blast.fun").searchParams.get("callsigns")!.split(",");
    batches.push(names);
    return Response.json(Object.fromEntries(names.map((name) => [name, name === "kai" ? countdown : null])));
  };
  const load = createCardIdentityLoader(request);
  const result = await Promise.all([load("nova"), load("kai"), load("kai"), ...Array.from({ length: 60 }, (_, n) => load(`user_${n}`))]);
  assert.equal(batches.length, 2);
  assert.ok(batches.every((batch) => batch.length <= 50));
  assert.deepEqual(batches[0], [...batches[0]!].sort());
  assert.deepEqual(result.slice(0, 3), [null, countdown, countdown]);
});

test("a malformed or failed batch rejects every waiting avatar instead of granting a wrong ring", async () => {
  for (const response of [Response.json({ kai: { ...countdown, edition: "quasar" }, nova: null }), Response.json({}), new Response("busy", { status: 503 })]) {
    const load = createCardIdentityLoader(async () => response);
    const results = await Promise.allSettled([load("kai"), load("nova")]);
    assert.ok(results.every((result) => result.status === "rejected"));
  }
});
