# Complete migration (public fallback)

`apps/web/src/components/launchpad/migration/` is the public Complete migration action
on the coin page. Migration is permissionless: while the launch object is
MigrationReady on a supported recorded route, any connected wallet may run
it, whether or not Blast's automation is running. The action never hides
because automation exists, exposes no automation keys and adds no admin
control. Blast's keeper runs the
[`launch-migration` job](../../apps/workers/src/modules/launch-migration/job.ts).
A launch it blocks stays MigrationReady for this action.

## Action

`migrationAdapter` is a `LaunchpadActionAdapter` on the shared transaction
boundary (`docs/launchpad/transactions.md`), so every attempt runs the fresh
preflight, review, one signature and reconciliation by digest.

| Step | Rule |
| --- | --- |
| Read | The launch object (`decodeLaunchObject`), its recorded route (`launchMigrationRoute`), the deployment's routes, and `ProtocolAccess.venues[venue]`, all fresh |
| Venue objects | Only `resolveVenueObjects(access, venue).migrate` from the deployment manifest; never another venue |
| Cetus CLMM | `cetusConfig`, `cetusPools`, the Cetus LP Burn `burnManager`; `memeSide` is `a` exactly when the Meme's type name (64-hex address without `0x`, module, name) sorts after the Quote's (`cetusMemeSide`) |
| Bluefin Spot | `bluefinConfig`, the shared `Currency<Quote>`, and Bluefin's SUI pool-creation fee read now with `getBluefinPoolCreationFee`; `migrateBluefin` pays exactly that fee |
| Currencies | The shared `Currency<Meme>` (and `Currency<Quote>` for Bluefin) at the Coin Registry's derived address |
| Eligibility | MigrationReady only (`stale-lifecycle`); supported, admitted, available venue (`stale-route`, with the reason and "no other venue"); with a non-zero Bluefin fee, a signer holding the fee plus a 0.05 SUI network-fee reserve, since both come from the same SUI (`insufficient-balance`) |
| Review | Network, signing wallet, deployment, launch state, recorded route and tier, the pool it creates (Cetus coin order), where the liquidity goes, what the signer pays; for Bluefin the exact fee in SUI and MIST and the signer's pool-manager role. A changed fee replaces the review |
| Build | The SDK's `migrateCetus` or `migrateBluefin` for the recorded venue |
| Completion | The checkpointed transaction's launchpad `Migrated` event |

A partial venue set is an invalid manifest and blocks every action
(`deployment-rejected`). An absent or unobserved set disables only that
venue.

## Completion and races

`createMigrationFlow` wraps the shared controller. A submitted digest is
never completion:

- **You:** the action succeeded, which needs the checkpointed `Migrated`
  event.
- **Another wallet or the automation:** after a `stale-lifecycle` or
  `simulation-failed` block, or any failure, the flow reads the launch object
  again (`getLaunch`). Migrated closes the action as completed elsewhere, with
  no retry. The panel says whether this wallet submitted nothing or its own
  transaction failed; it does not claim why that transaction failed.
- **A lost submission answer:** while this flow holds a submitted digest that
  Sui has not settled, nothing can leave it or start another attempt
  (`submit`, `approve`, `chooseSigner` and `acknowledge` are ignored; the
  panel offers only "Check again"). A checkpointed transaction without
  `Migrated` is settled and may be left. Before crediting another wallet, the
  flow reconciles its own unsettled digests; one carrying `Migrated`
  completes as yours.
- **Still ready:** the same read shows MigrationReady; the action stays
  visible with guidance and "Review again".
- **Unverified:** the read failed; nothing is claimed until "Check again"
  answers.

A verified completion re-reads the page from the server (`router.refresh()`),
which then shows the Migrated launch on the same URL.

## Diagnostics

Manual-fallback use and its verified outcome go to the site's analytics
(`track("launchpad_migration", …)`), never to the T-007 outcome store:

| `event` | Other properties | When |
| --- | --- | --- |
| `migration_manual_used` | `venue`: `cetus`, `bluefin`, `other` | a signed migration was submitted through this action |
| `migration_manual_completed` | `venue`, `by`: `self`, `other` | verified `Migrated` evidence only |

The fallback-use rate is `migration_manual_completed` with `by: self` over
all migrations on chain. The reporter never throws or waits, so analytics
cannot change the action.

## Signing chain

`configuredSigningChain` (`modules/launchpad-coin/chain.ts`) gives the
browser the released deployment on `BLAST_NETWORK` and its fullnode. While
the SDK registry holds no released deployment, and on the development
fixture origin (which serves objects only), it is null: the coin page shows
the action disabled with the reason, and the page updates when someone
migrates elsewhere. `CoinMigrationSlot` passes `PRIVY_APP_ID` and the
request CSP nonce to `LaunchpadWalletSignerProvider`.

## Verification

The [migration adapter tests](../../apps/web/src/components/launchpad/migration/migration-adapter.test.ts)
cover venue resolution and transaction construction. The
[flow tests](../../apps/web/src/components/launchpad/migration/migration-flow.test.ts)
cover review, submission and reconciliation.
