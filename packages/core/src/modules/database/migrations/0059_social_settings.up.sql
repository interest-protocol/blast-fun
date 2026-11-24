-- Social feed UI-07 (canonical UI §7, Settings): the account settings the
-- settings page stores on the server, and the index a wallet link needs.
--
-- - `portfolio_public` (owner decision OA-10): the "Public portfolio" switch,
--   off by default. Others may read the portfolio only while it is on and
--   the account is public (`GET /api/social/profiles/<callsign>/portfolio`).
-- - `explorer`: where the account's transaction links open, Suiscan by
--   default (the design's choice). A signed-out visitor's choice stays on the
--   device.
-- - `social_notification_preferences` (OA-11): the seven notification
--   switches. An account without a row has every switch on (the design's
--   defaults); the row appears on the first change. The notification system
--   reads them through `src/modules/social/notification-preferences`.
--
-- Both columns have constant defaults, so adding them rewrites no row.

ALTER TABLE social_accounts
  ADD COLUMN portfolio_public BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN explorer TEXT NOT NULL DEFAULT 'suiscan'
    CONSTRAINT social_accounts_explorer CHECK (explorer IN ('suiscan', 'suivision'));

CREATE TABLE social_notification_preferences (
  account_id UUID PRIMARY KEY REFERENCES social_accounts (account_id),
  opens_soon BOOLEAN NOT NULL DEFAULT true,
  almost_full BOOLEAN NOT NULL DEFAULT true,
  last_hour BOOLEAN NOT NULL DEFAULT true,
  funded BOOLEAN NOT NULL DEFAULT true,
  claims_open BOOLEAN NOT NULL DEFAULT true,
  unlocks BOOLEAN NOT NULL DEFAULT true,
  people_you_follow BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A wallet link refuses an address another account holds through any
-- source, looked up by address. Mission Control wallets and proven social
-- wallets are unique by address already; the presale embedded wallet cache is
-- keyed by Privy DID, so its address needs its own index (it also serves
-- `social_wallet_owners` filtered by address).
CREATE INDEX social_presale_embedded_wallets_address_idx ON presale_embedded_wallets (address);

-- Which account holds a callsign, as an indexed lookup: a member's callsign is
-- its Mission Control profile's, a new account's its own, and a filter on
-- `callsign` reaches each branch's unique index (`social_account_identities`
-- computes it with COALESCE, which no index serves). Like that view it runs
-- with its owner's rights, so the replica reads these two public columns and
-- nothing else of a profile. The public portfolio read resolves its callsign
-- here.
CREATE VIEW social_account_callsigns AS
SELECT a.account_id, p.callsign
FROM social_accounts a
JOIN mission_control_profiles p ON p.profile_id = a.profile_id
UNION ALL
SELECT a.account_id, a.callsign
FROM social_accounts a
WHERE a.profile_id IS NULL;

REVOKE ALL ON TABLE social_account_callsigns FROM PUBLIC;
GRANT SELECT ON TABLE social_account_callsigns TO blast_web, blast_replica;

-- The web runtime reads and writes the switches; the watcher, which will
-- send notifications, reads them. The replica reads none of them.
REVOKE ALL ON TABLE social_notification_preferences FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE social_notification_preferences TO blast_web;
GRANT SELECT ON TABLE social_notification_preferences TO blast_watcher;
