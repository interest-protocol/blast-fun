import assert from "node:assert/strict";
import test from "node:test";

import { launchpadEventBcs } from "@interest-protocol/blast-sdk/launchpad";
import { vaultEventBcs } from "@interest-protocol/blast-sdk/vault";
import { toBase64 } from "@mysten/sui/utils";

import { claimsBinding, launchClaimEvents } from "./launch-events.ts";

const LAUNCHPAD = `0x${"aa".repeat(32)}`;
const VAULT_PACKAGE = `0x${"bb".repeat(32)}`;
const OTHER = `0x${"cc".repeat(32)}`;
const LAUNCH = `0x${"1a".repeat(32)}`;
const VAULT = `0x${"2b".repeat(32)}`;
const packages = { launchpad: LAUNCHPAD, vault: VAULT_PACKAGE };

const curve = (address = LAUNCHPAD) => ({
  eventType: `${address}::events::CreatorFeesClaimed<0x2::sui::SUI,0x2::sui::SUI>`,
  bcs: launchpadEventBcs.CreatorFeesClaimed.serialize({ launch_id: LAUNCH, meme_amount: 5n, quote_amount: 7n }).toBytes(),
});
const vault = (address = VAULT_PACKAGE) => ({
  eventType: `${address}::blast_vault_events::OwnerBalancesClaimed<0x2::sui::SUI,0x2::sui::SUI>`,
  bcs: vaultEventBcs.OwnerBalancesClaimed.serialize({ vault_id: VAULT, meme_amount: 5n, quote_amount: 7n }).toBytes(),
});

test("LP-12: the curve's and a vault's creator fee claims decode with the SDK's layouts, from the configured packages only", () => {
  assert.deepEqual(launchClaimEvents([curve(), vault()], packages), [
    { kind: "claim_launch_fees", launchId: LAUNCH },
    { kind: "claim_launch_lp_fees", vaultId: VAULT },
  ]);
  // blast-infra's native evidence carries base64 BCS.
  const base64 = { ...curve(), bcs: toBase64(curve().bcs) };
  assert.deepEqual(launchClaimEvents([base64], packages), [{ kind: "claim_launch_fees", launchId: LAUNCH }]);
  // Another package's look-alike, another event of the package, or bytes that do not decode are not claims.
  const bought = { eventType: `${LAUNCHPAD}::events::Bought<0x2::sui::SUI,0x2::sui::SUI>`, bcs: new Uint8Array([1]) };
  const broken = { ...curve(), bcs: new Uint8Array([1, 2]) };
  assert.deepEqual(launchClaimEvents([curve(OTHER), vault(OTHER), bought, broken, { eventType: "not a type", bcs: new Uint8Array() }], packages), []);
});

test("LP-12: a claim matches its attempt only for the same ledger and the bound launch or vault", () => {
  const events = launchClaimEvents([curve(), vault()], packages);
  assert.equal(claimsBinding(events, "claim_launch_fees", { launchId: LAUNCH, vaultId: null }), true);
  assert.equal(claimsBinding(events, "claim_launch_lp_fees", { launchId: LAUNCH, vaultId: VAULT }), true);
  assert.equal(claimsBinding(events, "claim_launch_fees", { launchId: OTHER, vaultId: null }), false);
  assert.equal(claimsBinding(events, "claim_launch_lp_fees", { launchId: LAUNCH, vaultId: OTHER }), false);
  assert.equal(claimsBinding(launchClaimEvents([vault()], packages), "claim_launch_fees", { launchId: LAUNCH, vaultId: null }), false);
});
