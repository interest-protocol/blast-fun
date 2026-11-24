# OTW coin registration during presale creation

The frontend already calls `0x2::coin_registry::finalize_registration<T>` as
the middle transaction in `publishPresale`: publish the coin package, register
its currency, then create the presale. Keep registration here. The presale
builder needs the registered, shared `Currency<T>`; doing this after presale
creation is too late.

Sui's OTW initializer sends a pending `Currency<T>` to the Coin Registry at
`0xc`. Registration must happen in a subsequent transaction, and anyone may
perform it. It consumes the pending object, replaces its ID with the derived
registry ID, and shares the replacement. The published currency's ID is not
the shared currency's ID. See the [official OTW creation
guide](https://docs.sui.io/onchain-finance/fungible-tokens/create-a-fungible-token#one-time-witness-creation)
and [framework implementation](https://github.com/MystenLabs/sui/blob/main/crates/sui-framework/packages/sui-framework/sources/registries/coin_registry.move).

## Placement plan and implementation

1. Keep the frontend's existing three-transaction sequence. The server's
   `registerCurrencyTransaction` constructs the registration with
   `tx.receivingRef`, using the pending currency's ID, version and digest from
   confirmed publication effects. The creator's wallet signs it.
2. Before registration, reuse `findCurrencyRegistration` to check the canonical
   derived address for a matching shared currency. If someone already
   registered it while publishing was paused, proceed with that object and its
   initial shared version without another registration approval.
3. If registration preparation, submission or confirmation fails, check that
   address again. Continue only when chain state proves registration completed;
   otherwise propagate the error. Abort signals still stop publishing.
4. Preserve the existing bytes/digest checkpoints and completed publication.
   Retrying registration must never publish another coin or pass the pending
   currency ID to presale creation.

Steps 2–3 are implemented in `ensureCurrencyRegistration` in
`apps/web/src/components/social/create/create-publish-flow.ts`, with regression
coverage in its adjacent test file. The ordinary registration path reads the
replacement shared object from confirmed registration effects.

The existing operational registration worker checks `LaunchTicket` publication
lineage (a ticket, the Meme's `TreasuryCap` sealed as the core's
`SealedTreasuryCap`, and the pending `Currency`) and discovers launchpad
candidates. A presale sale token comes only from the `presale_coin_template`
package (contracts ADR 0138): its initializer hands the publisher a
`SealedTreasuryCap` sealed under the presale, with no ticket and no raw
`coin::TreasuryCap`, so that worker is not the presale registration
mechanism. The SDK's `coin_template` package keeps a raw cap and can no longer
start a sale. Keep the worker's lineage checks intact. A
background presale registrar would require explicit candidate discovery,
publication validation and gas sponsorship; creation already completes this
step through the frontend, so no new worker is needed for this change.

The publishing modal shows four steps: Create coin, Register currency, Create
presale, then Finalize coin. The fourth step records the confirmed presale’s
images and links; it requires no additional wallet approval. It stays paused
if saving fails, and retrying checks the saved transactions before saving again.
Only a successful save marks all four steps complete.

## Verification

The focused publish-flow tests cover the ordinary three-step sequence,
registration by another caller while paused or during preparation/submission,
wrong coin types, a non-shared object, and provider failure. Existing creation
transaction tests verify the framework registration call and the shared
currency input to presale creation. These checks use mocked chain responses;
they do not submit transactions or establish production deployment health.
