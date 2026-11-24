# Blast Accounts

Blast Accounts give a person one durable identity for their Mission Control profile, social logins, and Sui wallets without making any provider the account itself.

## Language

**Blast Account**:
The canonical member identity that owns the profile, callsign, crew membership, referrals, cards, linked identities, and linked wallets.
_Avoid_: Privy account, Slush account, profile account

**Linked Identity**:
A verified external login identity, such as an X or Google subject, attached to exactly one Blast Account.
_Avoid_: Social wallet, provider account

**Linked Wallet**:
A verified Sui wallet attached to exactly one Blast Account. A Blast Account may have both a Slush wallet and a Privy embedded wallet.
_Avoid_: Account wallet

**Primary Wallet**:
The linked wallet currently preferred for Blast actions and display. Changing it does not remove or transfer any linked wallet.
_Avoid_: Owner wallet, permanent wallet

**Embedded Wallet**:
A Sui wallet provisioned through Privy for a Blast Account whose member needs a wallet. Its custody and signing controls are defined by the active Privy wallet policy; do not infer user-only control from the word “embedded.”
_Avoid_: Blast wallet, Privy account

**Member Session**:
A revocable, remembered Blast login established after a linked identity or linked wallet successfully authenticates.
_Avoid_: Wallet connection, permanent login

**Wallet Connection**:
A wallet made available to the browser. Connection identifies an address but does not by itself authenticate control of that address to Blast.
_Avoid_: Wallet login

**Wallet Proof**:
A signature over a short-lived Blast nonce that proves control of a wallet without creating an on-chain transaction. Mission Control uses it for linked wallets; the launchpad accepts it from any wallet, with no Blast Account, to authorize one named write.
_Avoid_: Transaction, wallet connection

**Seed Creator**:
A launch partner selected to receive Initial Codes before they necessarily have a Blast Account. A Seed Creator is claimed by a Blast Account only after the expected X identity authenticates.
_Avoid_: Code owner, placeholder profile, influencer account

**Initial Code**:
A single-use invitation assigned to a Seed Creator before distribution. Its creator attribution exists independently of whether the Seed Creator has claimed a Blast Account.
_Avoid_: Team code, ownerless code

**Community Code Group**:
A named allocation of Initial Codes for a community, represented by one Seed Creator's verified X identity. One Seed Creator may represent multiple groups without merging their labels or code inventories.
_Avoid_: Separate creator, code prefix, community account

**Recruit Attribution**:
The durable record that a Blast Account joined with an Initial Code assigned to a Seed Creator. It is distinct from code consumption so a creator's own redemption does not create a self-referral.
_Avoid_: Code ownership, signup link
