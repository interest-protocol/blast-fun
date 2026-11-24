# TEST_SUI launch testing

TEST_SUI follows the same quote admission as every other quote coin. The deployed
CreationPolicy must list it, and the chosen venue must admit its quote and fee.
No application flag enables or disables it. Bonding-curve creation follows the
live LaunchConfig quote admission independently. Trades use the actual quote
token, balance and decimals.

Keep Production's launch/access flags at `team` and preserve the team password
while testing. The separate `BLAST_TEST_SUI_PRICE_ENABLED` display setting remains
unavailable in Production; TEST_SUI has no real USD value.
