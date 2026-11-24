# Presale allowlists

Uploads contain only the creator's CSV or JSON entries by default. Creators may
opt in to `include_blast_holders` to add verified wallets belonging to accounts
with a Blast card. For each account, Privy (embedded) takes precedence over
Slush (external); Slush is used when there is no Privy wallet.

New wallets receive the arithmetic mean of the original uploaded caps, computed
in integer quote atoms and rounded down. Original CSV caps and indices are
preserved. Duplicate wallets count once; the final list cannot exceed 65,536
wallets. Existing saved manifests and on-chain roots remain unchanged.

Migration `0123_allowlist_source` stores the original file name, uploaded row
count, opt-in setting, added count, and mean cap. Owner-authenticated
`GET /api/presale/allowlists/{allowlist_id}/entries` returns saved entries in
manifest index order for review and exact decimal CSV downloads. Original rows
remain at the beginning so changing the option rebuilds from the original CSV,
without compounding previously added wallets. Legacy manifests can be reviewed
and downloaded; replacing their CSV enables changing holder inclusion.

The old automatic 10,307-wallet cohort came from a frozen Privy signup export;
it did not establish Blast card ownership. New uploads use actual card and
verified wallet records instead.
