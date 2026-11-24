DROP INDEX presale_bridge_transfers_open_by_account;

DROP INDEX social_swap_intents_sponsored_idx;
CREATE INDEX social_swap_intents_sponsored_idx ON social_swap_intents (account_id, created_at_ms)
  WHERE fee_payer = 'blast' AND state <> 'failed';
