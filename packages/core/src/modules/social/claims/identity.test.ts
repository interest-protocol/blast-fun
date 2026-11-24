import assert from "node:assert/strict";
import test from "node:test";

import { claimIdempotencyKey, launchClaimBindingFromKey, launchClaimIdempotencyKey, vestingScheduleFromClaimKey } from "./identity.ts";

const REQUEST = "00000000-0000-4000-8000-000000000001";
const SCHEDULE = `0x${"a1".repeat(32)}`;

test("vesting claim keys bind one normalized schedule to the exact immutable attempt", () => {
  const key = claimIdempotencyKey("claim_vesting", REQUEST, SCHEDULE);
  assert.equal(key, `claim_vesting:${REQUEST}:${SCHEDULE}`);
  assert.ok(key.length <= 200);
  assert.equal(vestingScheduleFromClaimKey(key, REQUEST), SCHEDULE);
  assert.equal(claimIdempotencyKey("claim_vesting", REQUEST, "0x1"), `claim_vesting:${REQUEST}:0x${"1".padStart(64, "0")}`);
  assert.throws(() => claimIdempotencyKey("claim_vesting", REQUEST), TypeError);
  for (const invalid of [
    `claim_vesting:${REQUEST}`,
    `claim_refund:${REQUEST}:${SCHEDULE}`,
    `claim_vesting:${REQUEST}:0x1`,
    `${key}:extra`,
    key.toUpperCase(),
  ]) assert.equal(vestingScheduleFromClaimKey(invalid, REQUEST), null, invalid);
  assert.equal(vestingScheduleFromClaimKey(key, REQUEST.replace(/1$/, "2")), null);
  assert.equal(claimIdempotencyKey("claim_refund", REQUEST), `claim_refund:${REQUEST}`);
  assert.equal(claimIdempotencyKey("claim_tokens", REQUEST), `claim_tokens:${REQUEST}`);
});

test("creator attempt keys bind the action and exact vault",async () => {
  const {creatorVaultFromClaimKey}=await import("./identity.ts");
  for (const kind of ["collect_fees","claim_residuals"] as const) {
    const key=claimIdempotencyKey(kind,REQUEST,null,SCHEDULE);
    assert.equal(creatorVaultFromClaimKey(kind,key,REQUEST),SCHEDULE);
    assert.equal(creatorVaultFromClaimKey(kind,key,REQUEST.replace(/1$/,"2")),null);
    assert.equal(creatorVaultFromClaimKey(kind,`${key}:extra`,REQUEST),null);
    assert.throws(()=>claimIdempotencyKey(kind,REQUEST),TypeError);
  }
});

test("LP-12: a launch claim's key binds its launch, and a vault claim's the vault too, within the log's 200 characters", () => {
  const launch = `0x${"1a".repeat(32)}`;
  const vault = `0x${"2b".repeat(32)}`;
  const curve = launchClaimIdempotencyKey("claim_launch_fees", REQUEST, { launchId: launch, vaultId: null });
  assert.equal(curve, `claim_launch_fees:${REQUEST}:${launch}`);
  assert.deepEqual(launchClaimBindingFromKey("claim_launch_fees", curve, REQUEST), { launchId: launch, vaultId: null });
  const lp = launchClaimIdempotencyKey("claim_launch_lp_fees", REQUEST, { launchId: launch, vaultId: vault });
  assert.equal(lp, `claim_launch_lp_fees:${REQUEST}:${launch}:${vault}`);
  assert.ok(lp.length <= 200);
  assert.deepEqual(launchClaimBindingFromKey("claim_launch_lp_fees", lp, REQUEST), { launchId: launch, vaultId: vault });
  // Short ids are normalized; a key without its facts cannot be made.
  assert.equal(launchClaimIdempotencyKey("claim_launch_fees", REQUEST, { launchId: "0x1a", vaultId: null }), `claim_launch_fees:${REQUEST}:0x${"1a".padStart(64, "0")}`);
  assert.throws(() => launchClaimIdempotencyKey("claim_launch_lp_fees", REQUEST, { launchId: launch, vaultId: null }), TypeError);
  assert.throws(() => launchClaimIdempotencyKey("claim_launch_fees", REQUEST, { launchId: launch, vaultId: vault }), TypeError);
  for (const [kind, key] of [
    ["claim_launch_fees", lp],
    ["claim_launch_lp_fees", curve],
    ["claim_launch_fees", `claim_launch_fees:${REQUEST}`],
    ["claim_launch_fees", `${curve}:extra`],
    ["claim_launch_fees", `claim_launch_fees:00000000-0000-4000-8000-000000000002:${launch}`],
    ["collect_fees", `collect_fees:${REQUEST}:${launch}`],
  ] as const) {
    assert.equal(launchClaimBindingFromKey(kind, key, REQUEST), null, key);
  }
});

