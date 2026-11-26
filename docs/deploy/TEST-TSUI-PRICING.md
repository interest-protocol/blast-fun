# TSUI display pricing

Blast values one canonical TSUI at the current USD price of one SUI for
display, including on mainnet. The lookup uses the exact coin type. The SUI
mark must be positive, at most 120 seconds old and dated no later than the
current time. A missing mark leaves the USD value unavailable.

The bonding chart can display recorded quote prices using the current quote
rate. Its caption identifies that conversion. Historical USD data, trade
amounts, settlement and ledger entries retain their recorded values.

## TSUI-quoted coins

blast-infra prices coins quoted in TSUI (sale pools and bonding curves) in
`chain_read_v1.prices` and `price_history` like any other coin; the web
estimates none from pool marks.
