import assert from "node:assert/strict";
import test from "node:test";
import { rewardsSettingsFromEnvironment } from "./settings.ts";

test("executor settings default to 1023 claims and allow a smaller batch", () => {
  const env={REWARDS_PRICE_MAX_AGE_MS:"60000",REWARDS_PRICE_MAX_CONFIDENCE_BPS:"50",VAULT_REWARDS_ADMIN_CAP_ID:`0x${"a".repeat(64)}`};
  assert.deepEqual(rewardsSettingsFromEnvironment(env),{adminCapId:`0x${"a".repeat(64)}`,relayBatch:1023,pricePolicy:{maxAgeMs:60000,maxConfidenceBps:50}});
  assert.equal(rewardsSettingsFromEnvironment({...env,VAULT_REWARDS_RELAY_BATCH:"16"}).relayBatch,16);
  assert.throws(()=>rewardsSettingsFromEnvironment({...env,VAULT_REWARDS_RELAY_BATCH:"1024"}),/VAULT_REWARDS_RELAY_BATCH must be an integer from 1 to 1023/);
  assert.throws(()=>rewardsSettingsFromEnvironment({...env,VAULT_REWARDS_ADMIN_CAP_ID:"0x1"}),/VAULT_REWARDS_ADMIN_CAP_ID must be a canonical object ID/);
});
