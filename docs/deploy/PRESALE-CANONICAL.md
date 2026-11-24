# Fresh launch-stack cutover

The canonical seven-package stack was [published on Sui mainnet on 6 November 2026](https://github.com/interest-protocol/blast-v2-contracts/blob/main/deployments/sui/mainnet/2026-11-06-canonical-launch-stack.json). The publication record identifies the packages, genesis objects and custody. The app and workers use the published Blast SDK and deployment registry pinned to 0.3.0 in the lockfiles.

Follow the [worker go-live checklist](workers.md) and the [contracts admission and unpause procedure](https://github.com/interest-protocol/blast-v2-contracts/blob/main/deployments/README.md). The publication started with the vault and both products paused. Verify current on-chain settings and complete the release gates before enabling the app or workers. Obtain separate release approval for service changes, package publication, and on-chain transactions. Preserve account data and custody evidence.
