import assert from "node:assert/strict";
import test from "node:test";
import { plannerSettingsFromEnvironment } from "./settings.ts";

test("keyless planner requires explicit mainnet financial policy and defaults gas reserve to zero", () => {
  const env={BLAST_NETWORK:"mainnet",BLAST_DEPLOYMENT_FINGERPRINT:"a".repeat(64),REWARDS_PRICE_MAX_AGE_MS:"60000",REWARDS_PRICE_MAX_CONFIDENCE_BPS:"50"};
  assert.equal(plannerSettingsFromEnvironment(env).gasReserveBps,0);
  assert.deepEqual(plannerSettingsFromEnvironment(env).noMinimumVaults, []);
  assert.equal(plannerSettingsFromEnvironment(env).catchUpAtMs, null);
  const vault = `0x${"a".repeat(64)}`;
  assert.deepEqual(plannerSettingsFromEnvironment({
    ...env, REWARDS_NO_MINIMUM_VAULTS: JSON.stringify([vault, vault]), REWARDS_CATCH_UP_AT_MS: "1795677000000",
  }).noMinimumVaults, [vault]);
  assert.throws(() => plannerSettingsFromEnvironment({ ...env, REWARDS_NO_MINIMUM_VAULTS: '["0x2"]' }), /canonical addresses/);
  assert.throws(() => plannerSettingsFromEnvironment({ ...env, REWARDS_CATCH_UP_AT_MS: "1795677000000" }), /requires.*REWARDS_NO_MINIMUM_VAULTS/);
  assert.throws(()=>plannerSettingsFromEnvironment({...env,VAULT_REWARDS_SIGNER_KEY:"any"}),/VAULT_REWARDS_SIGNER_KEY must not be set: this command holds no signer key/);
  assert.throws(()=>plannerSettingsFromEnvironment({...env,REWARDS_GAS_RESERVE_BPS:"910"}),/integer/);
  assert.throws(()=>plannerSettingsFromEnvironment({...env,REWARDS_PRICE_MAX_AGE_MS:undefined}),/REWARDS_PRICE_MAX_AGE_MS is required/);
  assert.throws(()=>plannerSettingsFromEnvironment({...env,BLAST_NETWORK:"testnet"}),/mainnet/);
});
