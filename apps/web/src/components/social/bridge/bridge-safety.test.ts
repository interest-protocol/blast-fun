import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Quote } from "@mayanfinance/swap-sdk";

import { CHAINS, DESTINATIONS } from "./bridge-model.ts";
import { PRICE_WAIT_MS, worstLoss } from "./bridge-safety.ts";

const [quote] = JSON.parse(readFileSync(new URL("../../../../test/fixtures/social/bridge/all-routes-base-eth-sui.json", import.meta.url), "utf8")) as [Quote];

test("a price read that never answers ends as an unknown loss", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const loss = worstLoss({ quote, chain: "base", token: CHAINS.base.tokens[0], to: DESTINATIONS[0]!, read: () => new Promise(() => undefined), now: () => 0 });
  t.mock.timers.tick(PRICE_WAIT_MS);
  assert.deepEqual(await loss, { kind: "unknown" });
});
