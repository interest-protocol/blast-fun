# Bonding-curve launch creation

`/launch` is the Blast UI flow: Coin → Curve → Cover & details → Review.
`/bonding` lists launches by stage; `/coin/{launchId}` keeps each coin's chart,
trade, migration, holders and activity slots inside the Blast shell.
All three creation surfaces and the launch API require `BLAST_LAUNCHPAD_ENABLED`.

## Draft and publication

The core model in `packages/core/src/modules/social/launch/model.ts` owns parsing,
validation, SDK arguments and economics. The creator chooses the curve share;
the pool share and token-only recipient remainder must open the pool within
0.1% of the curve's terminal price, checked against SDK projections. Quote
recipients always receive zero basis points. Quotes, venues, fee tiers and
protocol shares come from the live chain configuration.

`social_launch_drafts` (migration 0148) holds autosaved account-owned drafts,
images and publication checkpoints. The backend builds all three transactions:

```text
saved draft
  publish_coin       → package, ticket, sealed treasury cap and coin type from confirmed effects
  register_currency  → shared currency
  create_launch      → confirmed Launch ID, optional pre-share first buy
```

Before returning a transaction for signing, the backend persists its complete
bytes and digest with compare-and-set locking. The first checkpoint freezes
editing and image changes. Retries and other devices receive the same plan;
client-provided coin types cannot replace the publication's confirmed effects.
A missing digest alone never authorizes minting another coin. Recovery needs a
confirmed failure, an expired unsubmitted sponsor reservation, or proof that
another finalized transaction consumed the exact wallet gas-object reference.
The history search is bounded; absence of proof keeps the checkpoint pending.

Blast wallets use the existing creation sponsor with intent `create`. The
creator recipient is the account commitment. Wallet signatures and actual
mainnet publication still require an explicit launch from the user.

The coin-page backend exposes only a published draft's tagline, cover and
validated links, selected by `published_launch_id`. Draft bodies, account IDs
and publication plans are never returned by that public projection. A missing
optional details read does not prevent the chain-backed coin page from loading.

## Release and verification

Apply migration 0148 to the release database, deploy the backend API, then deploy
Vercel. The backend deployment remains owned by the checkpoint session. An old
backend cannot answer launch context, so `/launch` reports that launch settings
could not be read until the API is updated. Dev access retains the team cookie.

The owner-provided mainnet snapshot on 2026-10-29 admits only TEST_SUI as a quote;
real SUI and USDC require an administrator to admit them. The picker follows
current configuration rather than assuming those assets are launchable.
Partner attribution and opening-round creation are deferred. See
[redesign data gaps](../design-system/REDESIGN-DATA-GAPS.md) for omitted read-page
figures whose data is not yet available.

Local verification uses disposable loopback PostgreSQL only: launch integration,
migration twice (second run current), and runtime-role grants. Relevant model,
route-policy, coin lifecycle, UI and reconciliation tests accompany the change.
No dependency or package-lock update is needed.

## Historical two-approval engine

The remainder describes the retired Quick/Advanced creation surfaces. Their
unreachable UI and controller files were removed when `/launch` replaced them,
and the engine's draft, lifecycle, preset, admission and Advanced form files
followed (#772). Of `apps/web/src/components/launchpad/launch/` only
`findCurrencyRegistration` (`chain-facts.ts`), the Cetus fee-tier reader
(`cetus-tiers.ts`) and the launchpad abort parser
(`advanced/contract-errors.ts`) remain, imported by trading, migration and
social launch code. Historical file references below are not the contract of
the current `/launch` flow.


`apps/web/src/components/launchpad/launch/` is the one engine Quick and Advanced launch
creation share. A creation surface owns only its form; the engine owns the
versioned local draft, both approvals, reconciliation after any interruption,
the Coin Registry wait, and retryable metadata. Each approval runs through the
shared transaction boundary ([transactions.md](transactions.md)): fresh
preflight, review, one signature, one submission. The chain decides what
happened: a created, shared `Launch` object is completion; local storage only
says where to look.

## Contract

| Piece | Where | Use |
| --- | --- | --- |
| `LaunchDraft`, `newLaunchDraft` | `draft.ts` | the versioned draft (below) |
| `browserLaunchDraftStore()` | `draft.ts` | `load()` → `empty`, `ok`, or `unreadable` (never repaired or deleted); `save()` throws when the draft cannot be stored; `clear()` |
| `useLaunchEngine({ chain, store, draft, presets?, metadata? })` | `use-launch-engine.ts` | returns `[state, controller]`; mount under a `LaunchpadSignerProvider`; `chain`, `store`, and `draft` are fixed for the component's lifetime |
| `createLaunchController(...)` | `launch-controller.ts` | the same without React; `reportOutcome` (default `reportVerifiedOutcome`) reports a completed launch once, and `commitOutcome` (default `commitSignedOutcome`) commits approval two's signed digest before submission |
| `LaunchEngineState`, `reduceLaunch`, `LaunchEvent` | `launch-machine.ts` | the pure lifecycle (below) |
| `publicationAdapter`, `creationAdapter` | `adapters.ts` | the two approvals as transaction-boundary adapters |
| `buildableVenues`, `venueLabel`, `venueTierText`, `venueUnavailable`, `venueUnavailableReasons`, `venueAdmitted` | `adapters.ts` | the venue table and each venue's creation gate ([Venues](#venues)) |
| `confirmStep`, `reconcileDraft`, `findOwnedTickets`, `findCurrencyRegistration` | `chain-facts.ts` | what the chain says about a draft |
| `parseQuickPreset`, `resolveLaunchPreset` | `presets.ts` | the Quick preset schema; values come only from the SDK or reviewed configuration |
| `uploadLaunchImage(...)` → `LaunchAssetUploadResult` | `asset-upload.ts` | the browser side of the image upload |
| `LaunchMetadataWriter` | `launch-controller.ts` | persists optional metadata after the chain completes |
| fixtures | `launch-fixtures.ts` | a fixture node that publishes, registers, and creates; fixture drafts |

### Controller commands

`edit(patch)`, `submit()`, `chooseSigner(kind)`, `cancel()`,
`approve(reviewId)`, `recheck()`, `acknowledge()`, `checkRegistration()`,
`retryMetadata()`, `startOver(draft, { abandonUnresolved? })`, `start()`,
`dispose()`. An `unresolved` draft is replaced only with `abandonUnresolved`
after the creator confirms; it is archived first
(`blast:launchpad:launch-draft-archive:v2`), never deleted. If the archive
cannot be written (for example, the storage quota is full), `startOver`
returns false, the draft stays, and a caution notice says so. Settled archived
drafts are capped at the newest ten; one that holds a publication or bytes that
may have reached the chain is never evicted.

`edit` takes `{ token?, settings?, purchase?, presetId?, metadataFields? }`.
Token fields lock once approval one is requested; settings, the creator's first
purchase, and the preset stay editable until approval two is requested.

### Verified outcome

The server records each completed launch for the wallet that sent its
creation, and links this browser's visitor to it only through the creator's
own evidence ([telemetry.md](telemetry.md)). The engine supplies both kinds:

- **Commitment.** In approval two's `onSigned`, after `submitting` is
  durably recorded and read back and just before the signed bytes are sent,
  the controller calls `commitOutcome({ kind: "launch", launchId, txDigest })`
  with the signed digest and the launch ID that the review's simulation of
  those exact bytes creates (its `LaunchCreated`; `simulatedLaunchId` in
  `adapters.ts`). It is not awaited, so the `submitting` read-back invariant
  and the submission are unchanged, and a throwing or failing commitment is
  ignored. The default is the browser's `commitSignedOutcome`. Approval one
  commits nothing.
- **Report.** When a draft first becomes `created` (the chain shows the
  shared launch), the controller calls `reportOutcome({ kind: "launch",
  launchId, txDigest })` with the creation's launch ID and digest, once,
  after its listeners have seen the completion. When the signer is a Privy
  wallet, the report carries its session's access token (`privyToken`, from
  `LaunchpadSigner.accessToken`). A token read that fails or does not settle
  within `PRIVY_TOKEN_TIMEOUT_MS` (2 s; option `privyTokenTimeoutMs`) is left
  out and the report is sent without it, so the launch is still recorded,
  wallet-only.
  The default is the browser's `reportVerifiedOutcome`: fire-and-forget, so
  it never delays or changes completion, and a throwing reporter is ignored.

A draft opened already `created` (a reopened finished launch) reconciles back
to `completed` without reporting again; a creation found complete on reload
(its answer was lost) reports when first seen. Quick and Advanced share this
path. `useLaunchEngine`, `QuickLaunch` and `AdvancedLaunch` take the same
optional `reportOutcome` and `commitOutcome`. The report is sent once, with
one retry after a 503, so recorded launches are a lower bound
([telemetry.md](telemetry.md)).

## Draft

Stored in `localStorage` under `blast:launchpad:launch-draft:v2` as
`{ schema: "blast.launch-draft", version: 2, draft }`. Amounts are decimal
strings in the SDK's atomic units. Every field is required; another version
or any invalid field makes the draft `unreadable`.

| Field | Meaning |
| --- | --- |
| `id`, `mode` (`quick` or `advanced`), `presetId`, `createdAtMs`, `updatedAtMs` | identity; Quick names a preset, Advanced carries `settings` |
| `lifecycle` | `draft`, `publish_pending`, `published`, `create_pending`, `created` |
| `identity` | `{ network, deploymentFingerprint, signer: { kind, address, chain } }`, bound when approval one is requested |
| `token` | symbol, name, description, `image` (an upload reference or null), decimals, burnable, sell-burn bps, creator recipient (address or account commitment) |
| `settings` | Advanced: venue, tier, virtual quote, graduation target, opening round, allocation plan, LP fee split, and `partner` (a `blast_partners::Partner` object ID, or null). Settings saved before `partner` existed read as naming none |
| `purchase` | the creator's first action: `buy` (no opening round) or `bid` (with one), or null |
| `metadata` | `{ fields, status: not_required \| pending \| saved \| failed, message }` |
| `approvals.publication`, `approvals.creation` | `{ attempts, confirmedFacts }`; each attempt is `{ reviewId, digest, requestedAtMs, outcome, message, gas, expiresAfterEpoch }` (`gas`: the gas coin versions the bytes pay with) with outcome `requested`, `submitting` (the wallet returned a signature; written before the bytes are sent), `rejected`, `signature-failed`, `submitted`, `unknown`, `failed`, `not-found`, or `confirmed`; one attempt per digest, at most 20 |
| `publication` | `{ digest, packageId, memeType, ticket: { objectId, version, digest, owner }, sealedTreasuryCap: { objectId, version, digest, owner }, pendingCurrency }`, read from approval one's effects |
| `registration` | the shared `Currency<Meme>`: `{ objectId, initialSharedVersion }` |
| `creation` | `{ digest, launch: { objectId, initialSharedVersion }, memeType, quoteType }`, read from approval two's effects |

A pending lifecycle always names its attempt. The engine writes
`publish_pending` (or `create_pending`), the identity, the transaction digest
(computed from the reviewed bytes), and the approved facts **before** it asks
the wallet to sign. If that write fails, nothing is signed.

## Lifecycle

| Stage | Meaning | Leaves by |
| --- | --- | --- |
| `reconciling` | a resumed draft (or one whose submission was unconfirmed) is being read from the chain; no approval is offered | the facts found |
| `unresolved` | the node could not answer, or a transaction is not checkpointed yet | `recheck` |
| `publication` | approval one, through the shared phases (`editing` … `succeeded`) | confirmed effects → `registration` or `creation` |
| `registration` | published; waiting for the Coin Registry to share `Currency<Meme>`; `state.registration` is `{ checks, lastCheckedAtMs, lastError, delayed }` | the shared currency is found (checked after 5 s, doubling to every 60 s, or `checkRegistration`) |
| `creation` | approval two | confirmed effects → `completed` |
| `completed` | the chain shows the shared launch | — |

Events: `edit`, `approval` (the shared machine's events), `signature-requested`,
`step-confirmed`, `reconcile`, `reconciled`, `registration-checked`, `registration-found`,
`metadata-saving`, `metadata-saved`, `metadata-failed`, `start-over`. Results
for another attempt or reconciliation are ignored.

Rules:

- One signature per approval request; nothing signs or submits on its own.
- A declined or failed signature returns the lifecycle to where it was.
- A lost submission answer stays pending (`ambiguous`). `recheck` waits for
  the digest; `acknowledge` reconciles instead.
- Reconciliation first checks that the node answers **for the deployment's
  chain**; otherwise it is `unresolved` and offers only "Check again". It then
  reads every recorded attempt's digest, then the signer's unconsumed
  `LaunchTicket`s whose publication is one of those digests, then the currency
  registration, then the creation. A recorded publication is never forgotten;
  a recorded creation counts only once its `Launch` object is read.
- Both approvals expire after the epoch following the review (`Epoch`
  expiration, when the node reports its epoch), so bytes that were sent but
  never landed become provably dead once that epoch passes.
- A node with no record of a digest proves nothing on its own. Bytes the
  wallet never answered for (outcome `requested`) never left the app, so they
  settle as `not-found`. The engine records `submitting` as soon as the
  signature returns, before sending. Bytes that were signed or submitted
  (`submitting`, `submitted`, or `unknown`)
  settle as `not-found` only with proof they can never execute: another
  transaction consumed a gas coin version they pay with (read from the coin's
  last transaction's effects), or their expiration epoch has passed. Until
  then the draft stays pending and `unresolved`, and the engine never says
  nothing was published. If the proof never arrives (the wallet's gas coin is
  never spent again and the node gave no epoch for an expiration), the creator
  can only check again or set the draft aside. The pending notice names the
  expiration epoch and how the attempt settles.
- Both approvals' preflight blocks, with that venue's reason, when the
  draft's venue is unavailable ([Venues](#venues)), its adapter is not
  admitted, or its tier is not in the manifest. Approval two's preflight also
  blocks, with a reason, when the deployment
  fingerprint or network differs from `identity`, the signer is not the
  publishing wallet, the generated type does not match the package and the
  draft's symbol, the ticket is gone or not owned by the signer, the currency
  is not registered, the live `LaunchConfig` no longer admits the decimals, the Quick preset is
  unavailable, LaunchConfig no longer accepts the named partner (its `PartnerKey`
  is absent or its removal deadline has passed), or the balance cannot cover the
  fresh creation fee and purchase. The review names the partner and its current
  share of Blast's fees, so a changed share needs a new approval.
- Approval two reviews what the launch snapshots from `LaunchConfig` at
  creation: the creation fee, the curve trade fees on the Quote and on the coin
  (`quote-trade-fee`, `meme-trade-fee`), and Blast's allocation shares of the
  supply and of the SUI raised (`blast-meme-allocation`,
  `blast-quote-allocation`). A change between review and approval replaces the
  review and needs a new confirmation; nothing is signed. A draft approved
  before these facts existed shows them as changes once.
- Before either approval, the allocation plan must total exactly 100% of the
  supply and of the SUI raised with LaunchConfig's live Blast share
  (`addProtocolAllocation`), so a coin is never published for a launch the
  contract would refuse. Quick says its preset no longer fits; Advanced names
  the totals. A Blast share change after the creation review therefore blocks
  the stale approval rather than asking for reconfirmation.
- Approval one refuses a coin name over 128 characters or a description over
  1,024 (`MAX_TOKEN_NAME_LENGTH`, `MAX_TOKEN_DESCRIPTION_LENGTH` in
  `draft.ts`). These are Blast's storage limits, not contract or SDK rules,
  and Quick and Advanced apply the same ones.
- A review whose facts differ from the facts approved before (even across a
  reload) lists `configurationChanges` and needs a new approval.
- Metadata is written only after completion. A failure marks it `failed` and
  retryable; the launch stays `completed`.
- A failed registration check sets `registration.lastError` and a caution
  notice. Ten minutes after approval one was requested the wait is `delayed`,
  with a notice that the coin and its ticket are safe in the wallet, Blast
  completes the registration, and the creator can leave and resume.

## Venues

One venue table in `adapters.ts` holds every venue the engine creates
launches on: its label, its adapter witness, how the review states its tier,
and its builder.

| Venue | Label | Builder | Tier |
| --- | --- | --- | --- |
| `bluefin` | Bluefin | `MigratorTransactions.createBluefinLaunch` (tick spacing and fee rate) | tick spacing and fee rate, as the manifest records them |
| `cetus` | Cetus CLMM | `MigratorTransactions.createCetusLaunch` (tick spacing, with `cetusConfig` and `cetusPools` from `resolveVenueObjects(access, "cetus").create`) | tick spacing; Cetus fixes the fee rate of each registered spacing, which the manifest tier records |

A venue's creation needs, in order, each with its own reason:

1. `ProtocolAccess.venues[venue].available` from the SDK's evaluation of the
   node's observation (`venueUnavailable`): its venue set is recorded and
   routed, and every object in it is observed at its recorded type. Bluefin's
   creation takes no venue object, but a Bluefin launch created without
   Bluefin's recorded set could never migrate or trade in the app, so the same
   gate applies. A partial set is an invalid manifest and disables all signing.
   An absent or mismatched set disables only that venue.
2. The draft's tier is one the manifest records for the venue.
3. LaunchConfig admits the venue's adapter witness (`venueAdmitted`).
4. For Cetus, Cetus registers the tick spacing now at exactly the fee rate the
   manifest records (`cetusTierProblem` over `readCetusFees`, `cetus-tiers.ts`,
   which decodes the leading fields of the recorded Cetus `GlobalConfig`: its
   `fee_tiers`; the layout is checked against Cetus's mainnet object as
   contracts 442116a snapshots it). The SDK has no reader for it.

Quick availability and Advanced admission read Cetus's tiers on their own,
after LaunchConfig (`readCetusTiers`): a failed read makes only Cetus
unavailable, with the reason, and never affects a Bluefin preset or draft.
The approvals read them only for a Cetus draft.

The gate applies in Advanced's venue and tier fields (`readAdvancedAdmission`
reads each venue's availability with `evaluateProtocolAccess`, and Cetus's
registered tiers), in Quick preset resolution (`selectQuickPreset` refuses a
preset whose venue fails with `venue-unavailable`, or whose Cetus tier fails
with `tier-unavailable`, naming the venue and its reason), on the Quick page
(`quickCreationProblem` shows the reason), and in **both**
approvals' preflight, so a coin is never published at approval one for a
venue or tier that cannot be created. A failure for one venue never affects
the other. Unavailable reasons read, for example, "Cetus CLMM is unavailable
on this Blast deployment (the manifest records no cetus packages and objects),
so no launch can be created on it now." or "Cetus now charges fee rate 5000
(0.5%) at tick spacing 200, but Blast's deployment records 10000 (1%), so a
launch at this tier would not match its review."

For a Cetus draft, approval two also reviews the recorded Cetus objects
(`cetus-objects`: the Cetus config and pool registry) and checks the
simulation of the exact bytes: its single `LaunchCreated` event must record
the Cetus adapter witness and the reviewed tick spacing and fee rate, so a fee
rate Cetus changes between the read and the simulation still blocks the
signature. When `cetus::new` aborts in the recorded Cetus CLMM package (Cetus
does not register the spacing or refuses the pair at it, leaving Cetus
unchanged), `contractRejection` points Advanced at the tier field.

A blocked approval is shown in the creator's terms (`blockRejection` in
`advanced/contract-errors.ts`): the adapter names the field of a venue or tier
refusal on the block itself (`Eligibility.field` → `PreflightBlock.field`); a
contract abort and the simulation check's Cetus tier reason (in the block's
details) are mapped too. The panel shows that reason instead of the raw text,
and Advanced links to the field. "Review again" reads Sui again: a cause that
has cleared opens the review, and one that persists is refused again with its
reason. Quick, which has no venue or tier field, shows the same reason
without a field link, and asking for review reads Sui again and opens it only
once the cause has cleared; a published Quick coin continues in Advanced to
choose another tier or venue.

## Quick presets

`parseQuickPreset` validates a preset as configuration carries it (exact
fields, decimal strings) through the SDK's `defineQuickPreset`.
`resolveLaunchPreset` returns exactly the named preset's values for exactly the
accepted deployment, or why not (`unknown-preset`, `signing-disabled`,
`deployment-mismatch`, `sdk-incompatible`, `values-absent`). It reads core
signing only, as the SDK's `resolveQuickPreset` does: a preset's venue is
judged by `selectQuickPreset` and by both approvals ([Venues](#venues)). A
preset may name either venue. There is no fallback preset; the SDK ships none
(`QUICK_PRESETS` is empty).

## Launch images

`POST /api/launchpad/launch-assets` is a protected launchpad write
(`launch_asset`, [identity.md](identity.md)) with input exactly
`{ contentType, data }` (base64). The browser and the route share the policy in
`apps/web/src/lib/launchpad/launch-image.ts`:

- PNG, JPEG, or WebP, with a matching file signature;
- at most 36 KiB (so the 64 KiB body always fits a Wallet Proof), and at most
  256 KiB once re-encoded;
- 64 to 1,024 pixels per side (also checked in the browser when it can decode
  the file), one frame;
- no markup or script anywhere in the bytes (`<script`, `<svg`, `<html`, …).

After the credential is verified and before any database transaction (the
write's `prepare` step), the route decodes the image with `sharp`, applies
orientation, re-encodes it in the same format without metadata, and stores it at
`launch-assets/<sha256>.<ext>` in a **public** Vercel Blob store
(`LAUNCH_ASSET_BLOB_READ_WRITE_TOKEN`). Answers: 201 `{ asset: { url, sha256,
contentType, width, height, bytes } }`; 400 for a refused image (no proof is
spent, nothing is stored, no transaction opens); 503 when storage is unconfigured, fails, or answers
without an https URL. `uploadLaunchImage` returns `stored` (the only result a
draft accepts), `rejected`, `unauthorized`, or `unavailable`.

## Limits and follow-ups

- **Sealed treasury cap (contracts ADR 0138).** The coin's initializer
  transfers two objects to the publisher: the `LaunchTicket<Meme>` and the
  Meme's `TreasuryCap` sealed as `blast_core::sealed_treasury_cap::SealedTreasuryCap<Meme>`.
  No raw `coin::TreasuryCap` leaves a publication, so nobody can mint between
  the publication and the venue's `prepare`. Approval two passes the sealed
  cap to `launch::new`, which opens it; a Cetus launch first asks
  `launch_config::venue_admission` for the venue's `VenueAdmission` earlier in
  the same PTB, and `cetus::prepare` borrows the cap with it (Bluefin's
  `prepare` takes the sealed cap as proof of control only). Presale sale
  tokens come only from the `presale_coin_template` package, whose
  initializer seals the cap under the presale the same way. The web and
  server publication flows use the Blast SDK to verify the seal's package lineage,
  owner and object reference from the transaction effects. The [current Sui
  source tree](https://github.com/interest-protocol/blast-v2-contracts/tree/main/sui)
  contains the launch and presale packages and their token templates.
- **Registration.** `coin_registry::finalize_registration` must run between the
  approvals (the ticket is transferred by the initializer, so it cannot be one
  transaction). The engine never asks the creator to sign it; per contracts
  ADR 0024 Blast's operational worker (`npm run worker -w @blast/workers -- blast-keeper`, its own process, not a
  route) submits it with a gas-only key. See
  [operational-worker.md](operational-worker.md). The engine's registration
  wait needs no change: it finds the currency the worker shared.
- **Signing window.** Signed bytes are sent only after this engine has saved
  `submitting` for their digest and read it back from storage; otherwise
  (the write failed or was lost, or the engine was disposed, for example by
  an unmount or route change while the wallet prompt was open) nothing is
  sent and the attempt stays `requested`. A reload between the signature and
  the submission answer therefore needs proof. The only unrecorded case is a
  signature that returns after the page's JavaScript has stopped, and those
  bytes were never sent.
- **Metadata storage.** The engine calls a `LaunchMetadataWriter`; the
  concrete protected `launch_metadata` write belongs to the metadata feature.
- **Rate limit.** `launchpad_launch_asset` reuses the provisional `wallet`
  values.

## Quick launch

`quick/` is the Quick surface on this engine. It asks only the coin's image,
name, ticker, short description, and optional website/X/Telegram links, and
writes only validated identity to the draft, trimmed by the same rule as
Advanced (`normalizeCoinIdentity`), so a saved draft always reloads. Everything economic comes from one deployment-owned preset:

- `selectQuickPreset({ config, access })` parses the configuration as it is
  carried and enables Quick only when exactly one preset resolves for the
  confirmed deployment and this SDK. No deployment, a node that does not
  confirm it, malformed configuration, no preset, another deployment's
  preset, another SDK range, a preset without values, or two enabled presets
  each disable Quick with a stated reason. So does a preset whose venue the
  access makes unavailable or whose adapter LaunchConfig does not admit
  (`venue-unavailable`, naming the venue and its reason). There is no fallback.
- `readQuickAvailability` confirms the deployment on the node
  (`observeDeploymentRuntime` and `evaluateProtocolAccess`) first, then reads
  LaunchConfig: a preset whose plan no longer totals 100% with Blast's live
  share, or whose economics the SDK rejects, disables Quick
  (`preset-misfit`), as do 9 decimals no longer admitted
  (`decimals-refused`). If LaunchConfig changes while the page is open and the
  SDK review fails, Quick withdraws approval one the same way.
- The public `/launch` route shows Quick disabled (`serverQuickAvailability`,
  from `expectedDeployment`): the SDK registry holds no released deployment and
  `QUICK_PRESETS` is empty.
- Before the first signature the page shows the preset's settings (route and
  tier, Quote, virtual reserve, graduation target, opening round, allocation,
  pool-fee split, supply mode and sell burn, creator recipient, partner), the
  SDK review (starting price, valuations, supply, current fees), and how the
  two approvals work, and asks the creator to confirm them. The signing wallet
  becomes the creator recipient just before approval one is reviewed.
- "Change the economics in Advanced" converts the whole unsigned draft
  (`importQuickDraft`) and opens Advanced; Quick has no economic inputs.
- A published, not-yet-created Quick draft with no creation request that may
  still land (`requested`, `submitting`, `submitted`, `unknown`) can also
  "Continue in Advanced": it keeps its identity, publication, registration,
  and approval records, and only the launch settings become editable. This is
  the way forward when Blast's share changes after approval one (the blocked
  approval names it). A draft with a creation request in flight is never
  moved, and nothing is published again.
- `plan-fit.ts` (`checkPlanFit`, `creatorPlanOf`) is the one rule for whether
  settings fit LaunchConfig now (allocation totals with Blast's live share,
  then the SDK's economics); availability, the Quick page, the Advanced
  review, and both approvals use it, and messages name the cause.
- After completion the page reads the shared `Launch` and shows its stored
  values with the preset's ID, SDK range, and deployment.
- Diagnostics (`quick/diagnostics.ts`): `quick_resumed`, `quick_rejected`,
  `quick_failed` (approval, preflight block code, or metadata),
  `quick_completed` (only once the chain shows the launch, and once per
  launch: a per-browser ledger of reported launch IDs stops a reopened page
  from reporting it again, and a reopened finished launch is not a resume), and
  `quick_unavailable`, with closed-list properties only, sent through the
  site's analytics without blocking. Separately, the engine reports every
  completed launch to `POST /api/launchpad/outcomes`, which verifies the
  creation's `LaunchShared` on the node and records at most one `launch`
  outcome in the T-007 outcome store for the creating wallet (see "Verified
  outcome" above; launches linked to a visitor are a lower bound).

## Advanced launch

`advanced/` is the Advanced surface on this engine. `AdvancedLaunchEntry`
opens the stored draft (resumes Advanced, converts an unsigned Quick draft with
`importQuickDraft`, or starts a new one); `AdvancedLaunch` renders every
creator-selectable field (`fields.ts`: unit, effect, and the SDK input it
sets) before any wallet connects. `evaluateAdvancedForm` converts display
units to exact atomic draft values and reports each problem on its field,
checked against `readAdvancedAdmission` (LaunchConfig, the SUI Quote's
admission, the partner's `PartnerKey`). `deriveAdvancedReview` explains the
settings only through SDK calls (`addProtocolAllocation`,
`deriveLaunchEconomics`, `apportionMeme`/`apportionQuote`, `curvePrice`,
`previewBuy`). A launchpad abort in simulation is pointed at its field by
`contractRejection`; after approval two, `compareLaunchRecord` sets each
choice beside the shared `Launch` the SDK reads. The opening-round bounds
(60 to 300 seconds) and the abort-code table in `contract-errors.ts` are copied
from contracts 442116a (the SDK's ABI baseline; unchanged at 9e8d871),
`constants.move`, `errors.move`, and `allocation.move`; the SDK does not export
them yet. Aborts 6, 7, and 8, which the allocation plan and the pool-fee split
share, are told apart by the `allocation` function that raised them.
`SDK_INPUT_FIELDS` in `fields.ts` places every SDK builder input, typed against
the builders' parameter types, so a new input fails typechecking. Only SUI-quoted launches are built, on Bluefin or Cetus CLMM: the venue field
offers each venue with its availability, and the tier field the manifest's
recorded tiers (for Cetus, with the fee rate Cetus fixes for each spacing).
`SDK_INPUT_FIELDS` places the inputs of both venue builders. There is no public
mount yet: it needs a released deployment and the production signer and
upload credentials.

## Development harness

`/dev/launchpad/launch` (development only; a dev server started with `BLAST_LAUNCHPAD_ENABLED=true`) drives a fixture draft through both
approvals on the fixture node, with controls for the creator's first buy
(its creation then emits a `Bought` before `LaunchShared`), the Privy fixture
wallet's session token (sent with its completed launch's report; it links only
when the dev server's Privy settings point at a fixture Privy that issued it),
the wallet answer, lost or
dropped submissions, node outages, the registration worker (the harness marks
the wait delayed after 8 s), spending the gas coin elsewhere, the creation fee,
admitted decimals, the signing wallet, and metadata failures. “Reload the
engine” rebuilds it from the stored draft while the node keeps its state. Its
fixture creation emits the launch's `LaunchShared`, and on completion the
harness lands that transaction on the dev server's fixture node
(`LAUNCHPAD_FIXTURE_CHAIN_ORIGIN`) through the same-origin, dev-only
`POST /dev/launchpad/launch/fixture-transactions` before reporting it, so
the outcomes route verifies and records it, and it shows when the landing
failed. Its engine also commits the creation's digest to the real
commitments route before submission, and the harness lands the creation a
checkpoint's delay (1 s) after completion, checkpointed at that moment, so a
browser with a visitor cookie is linked to that launch. Only this harness lands its creation; the Quick and Advanced
fixture pages below report and commit nothing (their `reportOutcome` and
`commitOutcome` are no-ops).

`/dev/launchpad/launch/advanced` (development only; a dev server started with `BLAST_LAUNCHPAD_ENABLED=true`) drives Advanced launch on
the same fixture node, with controls for the fixture partner (accepted,
removal pending, removed, never accepted) and its share, admitted decimals,
the SUI Quote, a contract abort in simulation, the wallet
answer, the registration worker, and saving a complete Quick draft to open in
Advanced.

Both the Advanced and Quick pages carry the venue controls
(`VenueFixtureControls`): the recorded venue sets (both, no Cetus set, no
Bluefin set, or Cetus recording only tick spacing 60, which leaves a saved
tick-spacing-200 draft on an unrecorded tier), the Cetus objects and the
Bluefin `GlobalConfig` as the node reports them (recorded or mismatched type),
the Cetus and Bluefin adapters' admission, and whether the fixture Cetus
registers tick spacing 200 (at 1%, not at all, or at 0.5%, which differs from
the record), and whether the node's read of the Cetus `GlobalConfig` still
shows 200 at 1% (so a change after the read reaches the simulation: an abort
in `cetus::new` or the `LaunchCreated` check) or fails with a node error.
Changing the venue sets remounts the engine on that manifest; the pages share
it.

`/dev/launchpad/launch/quick` (development only; a dev server started with `BLAST_LAUNCHPAD_ENABLED=true`) drives Quick launch with
fixture preset configurations (one valid Bluefin preset, one valid Cetus CLMM
preset, none, another deployment's, without values, malformed, two enabled,
another SDK range), both signer kinds, the
wallet answer, lost or dropped submissions, node outages, the creation and
trade fees, the registration worker, metadata failures, and a diagnostics
log.
