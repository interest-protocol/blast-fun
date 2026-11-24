# Treasury residuals: claiming a vault's protocol-owned migration residual

A launch's migration can leave Meme and Quote that the pool did not take. The
migrators vault keeps them as Blast's **protocol-owned residual**
(`LpVault.protocol_meme_residual`, `protocol_quote_residual`). Unlike the LP-fee
shares, only a `TreasuryAdmin` can claim it:

```move
vault::claim_protocol_fees<Meme, Quote>(vault, migrators_version, &AdminWitness<TreasuryAdmin>, ctx): (Coin<Meme>, Coin<Quote>)
```

It returns the coins to the caller, so the claim and the transfer to the
treasury must be one transaction. By the owner's decision (LP-20, 2026-10-27)
this stays a manual multisig step: the operational worker holds no admin
capability and never signs it. The worker claims everything else
(`docs/launchpad/operational-worker.md`, "Fee-claim job").

## 1. Find the residuals

blast-infra's vault ledger (LP-08) reports them per launch:

```bash
curl -s -H "x-blast-infra-key: $BLAST_INFRA_API_KEY" \
  "$BLAST_INFRA_ORIGIN/v1/launches/<launch_id>/rewards" | jq '.vault | {vault_id, residual}'
```

`vault.residual.meme.outstanding` and `vault.residual.quote.outstanding` are
the atoms still held; `vault` is `null` before migration. The same object is
under `GET /v1/vaults/{vault_id}/rewards`. Confirm on chain before building
anything: read the vault with the SDK (`getLpVault(client, vaultId,
migratorsOriginalPackageId)`) and check `protocolMemeResidual` and
`protocolQuoteResidual`. The call aborts (`ENothingClaimable`) when both are
zero.

Read the treasury address from `GET /v1/launchpad/policy` (`treasury`, from the
launchpad's `TreasuryChanged`), and confirm it against the owner's records. Do
not take an address from a ticket, a chat or this document.

## 2. Build the transaction

The SDK builds the whole transaction: it signs in with the multisig's
`AdminCap` for `TreasuryAdmin`, claims, and transfers both coins to
`recipient` in the same PTB.

```ts
import { migratorsDeployment } from "@interest-protocol/blast-sdk/deployments";
import { MigratorTransactions } from "@interest-protocol/blast-sdk/migrators";

const migrators = new MigratorTransactions(migratorsDeployment(deployment));
const tx = migrators.claimProtocolFees({
  memeType,                 // the vault's Meme type, from getLpVault
  quoteType,                // its Quote type
  vault: { objectId: vaultId, initialSharedVersion, mutable: true },
  adminCapId,               // the multisig's AdminCap holding TreasuryAdmin
  recipient: treasury,      // from step 1
});
tx.setSender(multisigAddress);
const bytes = await tx.build({ client });
```

Several vaults may share one transaction: add one `claimProtocolFees` call
per vault after a single `signIn` (`migrators.call.signIn` and
`migrators.call.claimProtocolFees`), and transfer every returned coin to the
treasury in the same PTB. Never leave a returned coin untransferred: the
transaction would fail, and a claim without its transfer must not be signed.

## 3. Review and sign

1. Dry-run the bytes (`client.core.simulateTransaction`) and check the
   balance changes: the treasury receives exactly the vault's residuals, the
   vault's residual balances go to zero, and nothing else moves except the
   multisig's gas.
2. Check the commands: `blast_acl` sign-in for `TreasuryAdmin`, then
   `<migrators package>::vault::claim_protocol_fees` on the intended vault(s),
   then `TransferObjects` to the treasury. The migrators package must be the
   SDK deployment's (`deployment.packages.migrators.packageId`).
3. Collect the multisig signatures on the exact bytes and submit them.

## 4. Verify

The transaction emits the migrators' `ProtocolFeesClaimed` for each vault
(`vault_id`, the multisig as `sender`, the Meme and Quote amounts). Once
blast-infra applies its checkpoint, `vault.residual.*.claimed` equals the
amounts and `outstanding` is zero in `GET /v1/launches/{launch_id}/rewards`.
Record the digest with the treasury's books.
