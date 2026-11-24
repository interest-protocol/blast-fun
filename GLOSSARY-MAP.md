# Glossary Map

## Contexts

- [Blast Accounts](./docs/mission-control/GLOSSARY.md): one member identity across Mission Control profiles, social logins, Sui wallets and invitation codes
- [Holder Rewards](./docs/holder-rewards/GLOSSARY.md): plans each Vault's daily holder rewards, publishes them as Rounds, relays Claims and settles relay gas

## Relationships

- **Blast Accounts ↔ Holder Rewards**: "Account" means two things. In Blast Accounts, "account" alone means a Blast Account. In Holder Rewards, say Account Address: a Sui address that names no object. Holder Rewards pays Account Addresses and never reads Blast Accounts.
- **Holder Rewards → Blast Accounts**: The Portfolio shows a member the holder rewards paid to their Blast Account's wallets.
