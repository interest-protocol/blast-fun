-- The relay's rows are progress only: each round's claimed bitmap on chain
-- says which leaves are paid, so a re-applied 0101 opens them afresh.
DROP TABLE presale_reward_relay_leaves;
DROP TABLE presale_reward_relays;
