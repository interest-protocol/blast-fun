Offline test vectors for CCTP V2 withdrawals from Sui. All transaction data
and fee quotes are synthetic. The Iris messages have dummy attestations.

- `sui-burn-vectors.json` pins the three Move calls and the BCS layout of
  the `DepositForBurn` event. The public package and shared-object IDs,
  initial versions and mutability reflect the mainnet deployment. The pure
  arguments and event bytes use little-endian integers and a ULEB128 length
  for the hook vector. The expected bytes are independent of the production
  builder and decoder.
- `messages-*.json` model attested plain and forwarded Iris responses.
  Their CCTP message bytes follow Circle's big-endian wire format.
- `fees-*.json` exercise Iris fee tiers with and without forwarding, including
  Solana recipient setup.

[Circle's Sui package reference](https://developers.circle.com/cctp/references/sui-packages)
and [CCTP wire format](https://developers.circle.com/cctp/references/technical-guide#message-format)
describe the protocol.
