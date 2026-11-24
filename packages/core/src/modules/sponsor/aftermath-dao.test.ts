import assert from "node:assert/strict";
import test from "node:test";

import { AFTERMATH_DAO, AFTERMATH_DAO_SWAP_CALL } from "./aftermath-dao.ts";
import { SPONSOR_SWAP_CALLS } from "./swap-calls.ts";

test("the DAO-fee swap pins every shared object but the pool, from Aftermath's mainnet objects", () => {
  assert.deepEqual(
    AFTERMATH_DAO_SWAP_CALL.sharedObjects.map(({ objectId }) => objectId),
    [null, AFTERMATH_DAO.version, AFTERMATH_DAO.registry, AFTERMATH_DAO.vault, AFTERMATH_DAO.treasury, AFTERMATH_DAO.insuranceFund, AFTERMATH_DAO.referralVault],
  );
});

test("Aftermath's protocol objects match the Cetus aggregator's own aftermath::swap pins", () => {
  const aggregator = SPONSOR_SWAP_CALLS.find((call) => call.target === "aftermath::swap");
  assert.ok(aggregator);
  assert.deepEqual(
    aggregator.sharedObjects.filter(({ position }) => position >= 2).map(({ objectId }) => objectId),
    [AFTERMATH_DAO.registry, AFTERMATH_DAO.vault, AFTERMATH_DAO.treasury, AFTERMATH_DAO.insuranceFund, AFTERMATH_DAO.referralVault],
  );
});
