# Coin metadata and creation discovery

Coin identity and precision belong in the indexed database. Sui is authoritative;
the website and workers read `chain_read_v1.coin_metadata`, or the metadata fields
already exposed by `chain_read_v1.presales` and `chain_read_v1.coins`. Readers must
not guess decimals or require a USD price feed to identify a coin.

The companion `blast-infra` change records every observed Currency output,
including coins that are not yet used by a tracked presale. A background reader
uses the engine's existing authenticated Sui gRPC endpoint to hydrate whitelisted
quote types and tracked sale/launch coins. Missing metadata retries after one
minute; successful snapshots refresh after one day. RPC failures retain the last
valid snapshot and do not stop checkpoint ingestion. Checkpoint metadata takes
precedence over snapshots, with configured quote identity as a final fallback.
New missing identities are served before scheduled retries, with whitelisted
quotes ahead of presale coins and market-only coins. Hydration never invents
price coverage.

## Release order

These changes span the application monorepo and `blast-infra`. Preserve the
[private team-access configuration](../../deploy/LAUNCH-DEPLOY.md#presale-redeployments-and-rollback)
throughout deployment.

1. Apply the infrastructure migration
   `2026-11-03-000000_generic_coin_metadata`. Deploy/restart the updated engine
   with its existing gRPC endpoint and writer identity. The background reader
   starts after chain identity verification; no manual per-coin registration is
   needed. An archive-only replay without a gRPC endpoint cannot hydrate old
   metadata.
2. Verify pending quote and sale metadata reaches `chain_read_v1.coin_metadata`
   and the corresponding presale exposes the actual quote symbol and decimals.
   The reported ALON sale uses TSUI with 9 decimals. It was already on-chain;
   metadata recovery should make the existing sale discoverable without
   republishing it or sending another transaction.
3. Apply application migration `0110_social_presale_creation_discovery` through
   the normal application migration process, then deploy the application.
   Verified publication records supply a public creation announcement for older
   indexed sales that lack a chain creation lifecycle entry. The projection
   exposes only presale ID and publication time; private draft data stays private.
4. With authenticated team access, open the reported detail page, the Presales
   tab, Home feed, and the creator's Created profile tab. Confirm one creation
   announcement, correct quote precision, and no duplicate publication.
5. For a future quote whitelist, verify automatic metadata recovery without
   adding a hardcoded symbol, decimals, or price feed. Check a new coin's
   checkpoint metadata and an older whitelisted coin's hydration path.

## Publishing experience

The launch scene follows the real save/publish/register/presale operations. It
shows the user's coin and chosen quote asset, confirmed transactions, resumable
errors, and a success action after publication details are saved. A pool opens
after the presale reaches its target and launches; the scene describes liquidity
setup without claiming a pool was created during publication. Reduced motion
uses static stage illustrations and omits confetti.

Local regression and browser evidence does not establish that these changes
have been deployed. A complete signed wallet flow remains a release check.
