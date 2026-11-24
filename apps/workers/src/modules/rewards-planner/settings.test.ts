import assert from "node:assert/strict";
import test from "node:test";
import { plannerSettingsFromEnvironment } from "./settings.ts";

test("keyless planner requires explicit mainnet financial policy and defaults gas reserve to zero", () => {
  const env={BLAST_NETWORK:"mainnet",BLAST_DEPLOYMENT_FINGERPRINT:"a".repeat(64),REWARDS_PRICE_MAX_AGE_MS:"60000",REWARDS_PRICE_MAX_CONFIDENCE_BPS:"50"};
  assert.equal(plannerSettingsFromEnvironment(env).gasReserveBps,0);
  assert.throws(()=>plannerSettingsFromEnvironment({...env,VAULT_REWARDS_SIGNER_KEY:"any"}),/VAULT_REWARDS_SIGNER_KEY must not be set: this command holds no signer key/);
  assert.throws(()=>plannerSettingsFromEnvironment({...env,REWARDS_GAS_RESERVE_BPS:"910"}),/integer/);
  assert.throws(()=>plannerSettingsFromEnvironment({...env,REWARDS_PRICE_MAX_AGE_MS:undefined}),/REWARDS_PRICE_MAX_AGE_MS is required/);
  assert.throws(()=>plannerSettingsFromEnvironment({...env,BLAST_NETWORK:"testnet"}),/mainnet/);
});
