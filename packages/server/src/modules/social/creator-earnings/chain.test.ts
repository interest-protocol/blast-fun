import assert from "node:assert/strict";
import test from "node:test";
import { vaultEventBcs } from "@interest-protocol/blast-sdk/vault";
import { creatorEvents } from "@blast/core/modules/social/claims/creator-events.ts";
import { claimVerdict } from "@blast/server/modules/social/claims/chain.ts";
import { claimTestIdentity } from "../../../../test/fixtures/modules/social/claims/claim-fixtures.ts";

const id = (byte: string) => `0x${byte.repeat(32)}`;
const SALE = id("11"),
  VAULT = id("22"),
  OWNER = id("55"),
  OTHER = id("66");
const original = claimTestIdentity().presale.vault.originalPackageId;

test("only matching vault events and the recorded sender settle creator actions", () => {
  const residual = {
    eventType: `${original}::blast_vault_events::OwnerBalancesClaimed<0x2::sui::SUI,0x3::coin::COIN>`,
    bcs: vaultEventBcs.OwnerBalancesClaimed.serialize({
      vault_id: VAULT,
      meme_amount: 20n,
      quote_amount: 10n,
    }).toBytes(),
  };
  const decoded = creatorEvents([residual], original);
  assert.equal(decoded.length, 1);
  const claim = {
    presaleId: SALE,
    participant: OWNER,
    vaultId: VAULT,
    kind: "claim_residuals" as const,
  };
  const executed = {
    success: true,
    sender: OWNER,
    failure: null,
    claims: [],
    vestingClaims: [],
    creatorEvents: decoded,
    timestampMs: 100,
  };
  assert.equal(claimVerdict(claim, executed).state, "confirmed");
  for (const changed of [
    { ...claim, vaultId: OTHER },
    { ...claim, kind: "collect_fees" as const },
    { ...claim, participant: OTHER },
  ])
    assert.equal(claimVerdict(changed, executed).state, "failed");
  assert.equal(
    claimVerdict(claim, { ...executed, success: false }).state,
    "failed",
  );
});
