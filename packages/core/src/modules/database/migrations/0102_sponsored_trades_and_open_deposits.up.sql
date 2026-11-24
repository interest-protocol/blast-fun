-- Security review L2 and L6 (2026-10-07): two partial indexes for two caps.
--
-- L2. The daily cap on Blast-sponsored trades (`social_config`
-- `trade_sponsor_daily_cap`) counted an account's sponsored trades "excluding
-- the ones that failed" (0089). A trade that failed on chain (`execution_failed`,
-- or `price_moved` at settlement) was still paid for by Blast's sponsor, so it
-- now counts too; only a trade that never landed (`expired`) is left out. The
-- cap's query (`TRADE_SPONSORED_SINCE_SQL`) repeats this predicate exactly, so
-- the planner uses the index. A trade refused before it was built has no fee
-- payer and was never in either index.
DROP INDEX social_swap_intents_sponsored_idx;
CREATE INDEX social_swap_intents_sponsored_idx ON social_swap_intents (account_id, created_at_ms)
  WHERE fee_payer = 'blast' AND failure_code IS DISTINCT FROM 'expired';

-- L6. A signed-in (Privy) caller may hold only a few registered burns that
-- Circle has not attested yet (`status = 'sent'`): registering a burn hash
-- makes the bridge relayer poll Circle for it, so made-up hashes from one
-- account are capped (`BRIDGE_OPEN_REGISTRATIONS_PER_ACCOUNT`). The cap counts
-- by the DID the routes record from the caller's own token, never by an
-- address a request names: a stranger could otherwise fill someone else's.
CREATE INDEX presale_bridge_transfers_open_by_account ON presale_bridge_transfers (privy_did)
  WHERE status = 'sent' AND privy_did IS NOT NULL;
