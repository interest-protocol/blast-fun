# Launchpad transactions: signer, preflight, and reconciliation

`apps/web/src/components/launchpad/transaction/` is the one trust boundary every
launchpad financial action (buy, opening round, launch, venue, migration)
goes through. A vertical supplies an adapter and a form; the boundary owns
signer connection, fresh preflight, review, the single signature, submission,
reconciliation, and read invalidation. Signing needs a wallet only: no Blast
Account, member session, or Blast backend call.

## Contract

| Piece | Where | Use |
| --- | --- | --- |
| `LaunchpadActionAdapter<Input, Fresh>` | `preflight.ts` | what a vertical implements (below) |
| `LaunchpadChain` | `preflight.ts` | `{ client, manifest, mode }`: the Sui Core client and the deployment manifest every step uses |
| `ActionController` | `controller.ts` | `edit`, `submit`, `chooseSigner`, `cancel`, `approve(reviewId)`, `recheck`, `acknowledge`, `onInvalidate(listener)` |
| `ActionState` / `reduceAction` | `action-machine.ts` | the typed phases below; pure, attempt-stamped |
| `LaunchpadSigner` | `signer.ts` | `{ kind: "privy" \| "wallet", label, address, chain, signTransaction(bytes), accessToken?, signPersonalMessage? }`; `accessToken()` (Privy only) is the session's current Privy access token, sent only same-origin with a completed outcome's report ([telemetry.md](telemetry.md)) or as a thesis post's session ([social.md](social.md)); `signPersonalMessage(message)` (direct wallets only) signs a Wallet Proof challenge, a personal message and never a transaction, and returns its serialized signature |
| `LaunchpadWalletSignerProvider` | `LaunchpadWalletSignerProvider.tsx` | the production signer provider (below) |
| `actionStateFixtures()`, `createFixtureChain()`, fixture signers, `fixtureBuyAdapter` | `fixtures.ts` | reusable test and harness fixtures; one reducer state per phase |

### Adapter

| Member | Rule |
| --- | --- |
| `readFresh(context)` | read the required objects, balances, and route from the node, never from indexed data; list every required object with its `lineage` (`launchpad`, `migrators`, `blastSui`, `cetusClmm`, `bluefinSpot`); return `type: null` for an object that is absent |
| `eligibility(fresh, context)` | decide from fresh state only: `stale-lifecycle`, `stale-route`, `insufficient-balance`, or `ineligible` |
| `preview(fresh, context)` | the SDK preview as `MaterialFact[]` (`key`, `label`, `value`); any changed value between review and approval forces reconfirmation |
| `build(fresh, context)` | the SDK-built `Transaction`; the preflight sets the sender to the signer. `context.access` is the confirmed `ProtocolAccess` (signing enabled); a venue action also needs `access.venues[venue].available` |
| `checkSimulation(simulated, fresh, context)` (optional) | refuses a simulation that succeeded but is not the reviewed action (it throws; the review is `simulation-failed`). The simulation is read with its events |
| `expiresAtMs(fresh)` (optional) | when the reviewed quote stops being signable; it becomes `review.expiresAtMs` |
| `completion` | the configured-package evidence success needs: a launchpad or migrators event kind, a created object of a configured package type, or a `check` over the completed transaction |
| `completionFor(fresh, context)` (optional) | the evidence for this review's transaction (such as an SDK reconciliation against its quote); it replaces `completion` for the transaction signed after that review |
| `affectedReads(input)` | read keys refreshed after a completed transaction |

Indicative previews from dashboard reads belong to the form. They never decide
eligibility or build a transaction.

## Flow

| Phase | Meaning | Leaves by |
| --- | --- | --- |
| `editing` | entry, with an optional notice | `submit` |
| `choosing-signer` | submitted with no signer; nothing is connected yet | `chooseSigner`, `cancel` |
| `connecting` | the bridge is loading and connecting | connected, or back to `editing` with guidance |
| `preflighting` | fresh deployment, signer network, objects and lineage, eligibility, SDK preview, and exact simulation, each on its own | `review`, `blocked`, or wallet-confirmed `signing` |
| `blocked` | the reason and recovery; no signature is possible | `submit` (review again), `cancel` |
| `review` | fresh facts; non-empty `changes` means the review was replaced | `approve(reviewId)`, `cancel` |
| `signing` | one signature request for the exact simulated bytes | `rejected`, `failed`, `reconciling`, `ambiguous` |
| `rejected` | declined; nothing was submitted; entry kept | `submit` |
| `reconciling` | reading the digest | `succeeded`, `failed`, `ambiguous` |
| `succeeded` | checkpointed effects plus the expected configured-package evidence | `acknowledge` |
| `failed` | a signing failure or an on-chain abort; entry kept | `submit`, `acknowledge` |
| `ambiguous` | the submission answer was lost, or the transaction is unconfirmed or lacks its evidence | `recheck` (reads the digest only), `acknowledge` |

Rules:

- Approval re-runs the preflight. Unchanged facts go to one signature; changed
  facts return to `review`. Repeated clicks request one signature.
- `signAndSubmitOnce({ client, signer, review, onSigned? })`: the optional
  `onSigned(digest)` runs once after a valid signature and before sending,
  with the signed transaction's digest, so a caller can record that signed
  bytes may reach the chain. It may be synchronous or asynchronous and is
  awaited; if it throws or rejects, nothing is submitted.
- `createActionController({ …, onSigned? })`: the optional
  `onSigned({ digest, input })` is told each signed transaction's digest and
  the input it was reviewed for, after a valid signature and before the
  submission. Unlike `signAndSubmitOnce`'s, it is not awaited and a throw is
  ignored, so it can never delay, block, or change the submission. Without
  it the controller behaves exactly as before. The curve rail's Buy uses it
  to commit its signed digest ([trades.md](trades.md)).
- Nothing signs or submits again on its own. A lost answer is reconciled by
  digest; a declined or failed signature waits for the user.
- A wallet that returns bytes other than the reviewed ones is not submitted.
- Affected reads are invalidated after `succeeded` and after an on-chain
  failure, not while pending or after a rejection.
- Any unexpected error in preflight blocks the signature.
- A Core API client builds a transaction without a gas budget by simulating
  it first. A transaction that fails there (a Move abort, for instance) is
  Sui's refusal in simulation (`simulation-failed`, with the execution
  error), exactly as if the simulation itself had failed; only a node that
  cannot be asked is `simulation-unavailable`. A Sui mainnet dry run of the
  SDK-built Bluefin swap showed Bluefin's `slippage_exceeds` arriving this
  way (T-041).

## Explorer links

`explorerTransactionUrl(deployment, digest)` returns
`<explorer.baseUrl>/tx/<digest>` for completed digests only. The SDK manifest
carries only the base, so the `/tx/` path is this module's convention. The base
must be https without credentials, query, or fragment; plain http is accepted
only for a non-production explorer on a loopback host. An invalid base or
digest gives no link.

Curve Buy/Sell uses `submit({ confirmInWallet: true })`: it signs the exact fresh
simulation after the click, without a second in-app review. The click freezes the
minimum output displayed in the form; direct, routed and sponsored builds retain
that minimum. A worse fresh preview blocks signing and offers a quote refresh.
Default `submit()` keeps the review/reconfirmation flow for other actions.

## Mounting the production signers

```tsx
<LaunchpadWalletSignerProvider privyAppId={privyAppId} network={deployment.network} nonce={nonce}>
  <BuyForm />
</LaunchpadWalletSignerProvider>
```

- Mount it around the action, not in the launchpad layout, so public readers
  never need `PRIVY_APP_ID` or an auth handshake. The Privy and dApp Kit
  bridge loads only when the first action asks to connect.
- Both signer kinds sign for `network`. Direct wallets use a launchpad-owned
  dApp Kit for that one network with the storage key
  `blast:launchpad:wallet:v1`; Mission Control's dApp Kit is not shared.
  Privy's embedded key signs for the same network.
- Without `privyAppId`, only direct wallets are offered.

## SDK dependency

The SDK is `@interest-protocol/blast-sdk` from npm (0.1.2, the canonical
2026-10-28 mainnet stack). `@mysten/move-bytecode-template` loads outside the
server bundle. The SDK's
`launchpad` barrel also carries the Meme bytecode template and its WASM into
client chunks that import it; splitting it out is an SDK follow-up.

## Development harness

`/dev/launchpad/transactions` (development only; `?network=testnet` for a
testnet deployment identity) drives a fixture purchase through the boundary
with a fixture node, fixture signers, and controls for every failure mode.
