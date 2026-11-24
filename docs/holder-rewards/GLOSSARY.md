# Holder Rewards

Holder rewards pay a coin's holders a share of the fees its Vault collects, one Period at a time, as on-chain Rounds paid by proof. This context covers planning a Period, publishing its Round, relaying Claims and settling relay gas, for launches and presales alike.

## Language

### Funding

**Vault**:
The on-chain object that collects one coin's pool fees and keeps the share set aside for holder rewards.
_Avoid_: Pool, treasury

**Origin**:
The launch or presale that created a Vault. It records where the Vault came from, not who is paid.
_Avoid_: Product, source

**Meme**:
The coin whose holders a Vault rewards.
_Avoid_: Token, base coin

**Quote**:
The asset that Meme trades against in the Vault's pool.
_Avoid_: Base asset, paired coin

**Unreserved Rewards**:
The Meme and Quote in a Vault's holder-reward share that no Round has taken yet.
_Avoid_: Vault balance, pending rewards

**Budget**:
The Meme and Quote one Round takes from Unreserved Rewards: the total of its Leaves plus any Gas Reserve.
_Avoid_: Gross, funds, pot

**Treasury**:
Blast's multisig that receives Gas Reserve Settlements. Each Round records its Treasury.
_Avoid_: Fee wallet, vault

### Planning

**Period**:
One day of a Vault's history that at most one Round rewards. Periods follow each other from the Vault's creation. Holder Quote needs at least $100 after the Gas Reserve and at least $1 per Qualifying Holder. Every Round pays Quote to at least one Holder. If holders receive no Quote, the Period is skipped and both assets stay in the Vault.
_Avoid_: Epoch, day, cycle

**Cut**:
An exact checkpoint at which chain history is read. Each Period is read between its start Cut and its end Cut.
_Avoid_: Snapshot, block

**Rewards Planner**:
The keyless process that turns a Period into a Plan. It never signs a transaction.
_Avoid_: Daily planner

**Plan**:
The frozen off-chain record of one Period's rewards: its inputs, Qualifying Holders, Allocations and Manifest. A Plan reaches the chain as a Round.
_Avoid_: Distribution, batch, snapshot

**Holder**:
An address that held the Vault's Meme during a Period, in its own balance or in vesting.
_Avoid_: Owner, user, account

**Holder Weight**:
A Holder's Meme multiplied by how long it was held within the Period, counting Meme vesting for that Holder.
_Avoid_: Balance, stake, points

**Holder Window**:
The Holders of one Period and their Holder Weights, read between the Period's Cuts.
_Avoid_: Holder snapshot

**Excluded Address**:
An address never counted as a Holder: the Vault, its Origin and pool, the team allocation recipients, Treasury addresses, the coin's reward blacklist and operator-set exclusions.
_Avoid_: Blacklist (it is only one source of exclusions)

**Reward Floor**:
The smallest Holder Weight that qualifies, set as a USD value of Meme held on average across the Period.
_Avoid_: Minimum balance, dust limit

**Qualifying Holder**:
A Holder at an Account Address whose Holder Weight meets the Reward Floor. A Qualifying Holder gets a Leaf if either asset allocation is positive.
_Avoid_: Qualifier, eligible wallet

**Allocation**:
A Qualifying Holder's shares of a Round's Meme and Quote, each in proportion to its Holder Weight. Rounding leftovers stay in the Vault.
_Avoid_: Payout (a payout is a paid Claim), airdrop

### Addresses

**Account Address**:
A Sui address that names no object. Only an Account Address can be a Beneficiary. It is not a Blast Account.
_Avoid_: Account (alone), wallet

**Object Address**:
A Sui address that names an object, such as a pool, a vesting schedule or a vault. A coin paid to it is stranded, so an Object Address never gets a Leaf.
_Avoid_: Contract wallet

**Identity Check**:
Asking the chain whether an address names an object, to class it as an Account Address or an Object Address. An unknown answer never counts as an Account Address.
_Avoid_: Wallet check, account check

**Leaf Check**:
The Identity Check of every Leaf in a Plan before its Round is scheduled or published. One Object Address stops the Plan.
_Avoid_: Manifest check

### Rounds

**Round**:
The on-chain form of one Plan. It holds the Budget and pays each Leaf once, by proof, until the Claim Deadline. A Vault numbers its Rounds in order.
_Avoid_: Epoch, airdrop, distribution

**Leaf**:
One Beneficiary's committed Meme and Quote in a Round.
_Avoid_: Entry, row, claim

**Beneficiary**:
The Account Address that a Leaf pays.
_Avoid_: Recipient, claimant (in the contracts, a claimant receives creator authority)

**Manifest**:
The immutable public file that lists every Leaf of a Plan with its proof, together with the Plan's inputs. Its Round commits to its digest.
_Avoid_: Snapshot, allocation file

**Round Delay**:
The wait a Vault enforces between scheduling a Round and publishing it.
_Avoid_: Timelock, cooldown

**Claim Window**:
The time from a Round's publication to its Claim Deadline, during which its Leaves can be paid.
_Avoid_: Claim period

**Claim**:
The single payment of one Leaf to its Beneficiary, before the Claim Deadline. It is not a creator claim of fee shares.
_Avoid_: Withdrawal, redemption

**Relay**:
Sending Claims on the Beneficiaries' behalf, so they need not act. Anyone may relay an unchanged proof; the Rewards Executor relays every unclaimed Leaf.
_Avoid_: Airdrop, push, distribute

**Close**:
Ending a Round at or after its Claim Deadline. Closing returns every unpaid Leaf and any unsettled Gas Reserve to the Vault.
_Avoid_: Expire, sweep

**Rewards Executor**:
The process that holds the rewards admin role for both products. It schedules and publishes Rounds, relays Claims, settles the Gas Reserve and closes Rounds.
_Avoid_: Rewards bot, presale rewards worker

### Gas

**Gas Reserve**:
Quote set aside in a Round, apart from its Leaves, to repay the gas spent to schedule, publish and relay it. It is capped at a tenth of the Round's holder Quote; zero turns it off.
_Avoid_: Reserve (alone), fee

**Gas Reserve Settlement**:
The single payment of a Round's measured gas, capped by its Gas Reserve, to the Treasury. The rest of the Gas Reserve returns to the Vault at the same time.
_Avoid_: Gas refund, rebate
