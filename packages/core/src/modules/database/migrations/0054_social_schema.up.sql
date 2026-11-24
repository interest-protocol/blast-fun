-- Social feed (T-001): the social data model of module `social`
-- (src/modules/social). Social rows refer to the feed by `entry_id` text,
-- derived from chain identity (0055 `social_feed_entries`), so a reaction,
-- why, intent or attribution stays valid after an indexer rebuild. No social
-- table stores chain activity: chain facts are read through blast-infra's
-- `chain_read_v1` views at read time.
--
-- Length CHECKs here are safety ceilings, not product limits.

-- A social member. An account either extends a Mission Control profile (its
-- callsign is the profile's) or is new and holds its own callsign and Privy
-- DID. A private account shares nothing, so it has no sharing start.
CREATE TABLE social_accounts (
  account_id UUID PRIMARY KEY,
  privy_did TEXT UNIQUE CHECK (privy_did LIKE 'did:privy:%'),
  profile_id UUID UNIQUE REFERENCES mission_control_profiles (profile_id),
  callsign TEXT UNIQUE CHECK (callsign ~ '^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$'),
  display_name TEXT CHECK (char_length(display_name) BETWEEN 1 AND 100),
  x_subject TEXT CHECK (char_length(x_subject) BETWEEN 1 AND 512),
  x_handle TEXT CHECK (char_length(x_handle) BETWEEN 1 AND 100),
  x_display_name TEXT CHECK (char_length(x_display_name) BETWEEN 1 AND 200),
  x_avatar_url TEXT CHECK (char_length(x_avatar_url) BETWEEN 1 AND 2048),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  onboarding_shown_at TIMESTAMPTZ,
  onboarded_at TIMESTAMPTZ,
  default_follows_applied_at TIMESTAMPTZ,
  launch_code_follow_applied_at TIMESTAMPTZ,
  privacy TEXT NOT NULL DEFAULT 'public' CHECK (privacy IN ('public', 'private')),
  sharing_since TIMESTAMPTZ,
  commit_too_amount_usd NUMERIC(12, 2) NOT NULL DEFAULT 50 CHECK (commit_too_amount_usd > 0),
  CONSTRAINT social_accounts_profile_or_callsign CHECK ((profile_id IS NULL) <> (callsign IS NULL)),
  CONSTRAINT social_accounts_new_account_privy_did CHECK (profile_id IS NOT NULL OR privy_did IS NOT NULL),
  CONSTRAINT social_accounts_private_not_sharing CHECK (privacy = 'public' OR sharing_since IS NULL)
);

-- Wallets an account proved outside Mission Control and the presale embedded wallet cache.
CREATE TABLE social_account_wallets (
  address TEXT PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{64}$'),
  account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  kind TEXT NOT NULL DEFAULT 'external' CHECK (kind ~ '^[a-z][a-z_]{0,31}$'),
  verified_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX social_account_wallets_account_idx ON social_account_wallets (account_id);

-- Follows of an account (`target_id` is its account id) or a presale (its presale id).
CREATE TABLE social_follows (
  follower_account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('account', 'presale')),
  target_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'default', 'launch_code')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_account_id, target_kind, target_id),
  CHECK (
    (target_kind = 'account' AND target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR (target_kind = 'presale' AND target_id ~ '^0x[0-9a-f]{64}$')
  )
);

CREATE INDEX social_follows_target_idx ON social_follows (target_kind, target_id);

-- The accounts a new member follows by default, in order.
CREATE TABLE social_default_accounts (
  position SMALLINT PRIMARY KEY CHECK (position BETWEEN 1 AND 5),
  account_id UUID NOT NULL UNIQUE REFERENCES social_accounts (account_id)
);

-- A presale crossing a participants, raise or holders threshold. Its entry id
-- is derived from the presale, the kind and the threshold, so it never changes.
CREATE TABLE social_milestones (
  entry_id TEXT PRIMARY KEY,
  presale_id TEXT NOT NULL CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  coin_type TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('participants', 'raise', 'holders')),
  value NUMERIC NOT NULL CHECK (value > 0),
  activity_id TEXT,
  digest TEXT,
  timestamp_ms BIGINT NOT NULL CHECK (timestamp_ms >= 0),
  CONSTRAINT social_milestones_entry_id CHECK (entry_id = 'm:' || presale_id || ':' || kind || ':' || value::text)
);

CREATE INDEX social_milestones_time_idx ON social_milestones (timestamp_ms DESC);
CREATE INDEX social_milestones_presale_time_idx ON social_milestones (presale_id, timestamp_ms DESC);

-- A member's reason on a feed entry: at most one active why per entry. A why
-- is kept after its author deletes it or an operator removes it.
CREATE TABLE social_whys (
  why_id UUID PRIMARY KEY,
  entry_id TEXT NOT NULL,
  author_account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleted', 'removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  removed_by TEXT,
  removal_reason TEXT,
  CHECK ((state = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK ((state = 'removed') = (removed_at IS NOT NULL AND removed_by IS NOT NULL))
);

CREATE UNIQUE INDEX social_whys_active_entry_idx ON social_whys (entry_id) WHERE state = 'active';
CREATE INDEX social_whys_author_idx ON social_whys (author_account_id);

CREATE TABLE social_why_reports (
  why_id UUID NOT NULL REFERENCES social_whys (why_id),
  reporter_account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  reason TEXT CHECK (char_length(reason) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (why_id, reporter_account_id)
);

CREATE TABLE social_reactions (
  entry_id TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  reaction TEXT NOT NULL CHECK (reaction ~ '^[a-z][a-z0-9_]{0,31}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, account_id, reaction)
);

-- A member's declared transaction, registered before the chain shows it; the
-- watcher resolves it against the activity its digest produces.
CREATE TABLE social_intents (
  tx_digest TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  action TEXT NOT NULL CHECK (action IN ('commit', 'buy', 'sell')),
  presale_id TEXT NOT NULL CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  source_entry_id TEXT,
  why_text TEXT CHECK (char_length(why_text) BETWEEN 1 AND 2000),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected_sender', 'late')),
  resolved_at TIMESTAMPTZ,
  CHECK ((status = 'pending') = (resolved_at IS NULL))
);

-- A chain action credited to the entry (and its why's author) that led to it.
-- Never deleted: an operator voids one instead.
CREATE TABLE social_attributions (
  tx_digest TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  author_account_id UUID REFERENCES social_accounts (account_id),
  actor_account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  action TEXT NOT NULL CHECK (action IN ('commit', 'buy', 'sell')),
  presale_id TEXT NOT NULL CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  quote_amount NUMERIC NOT NULL CHECK (quote_amount >= 0),
  usd_value NUMERIC CHECK (usd_value >= 0),
  occurred_at_ms BIGINT NOT NULL CHECK (occurred_at_ms >= 0),
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);

CREATE INDEX social_attributions_entry_idx ON social_attributions (entry_id);
CREATE INDEX social_attributions_author_idx ON social_attributions (author_account_id);

CREATE TABLE social_config (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]{0,63}$'),
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
);

CREATE TABLE social_blocked_terms (
  term TEXT PRIMARY KEY CHECK (char_length(term) BETWEEN 1 AND 200 AND term = lower(term)),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by TEXT NOT NULL
);

CREATE TABLE social_operator_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  before JSONB,
  after JSONB,
  reason TEXT,
  acted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The social workers' progress cursors.
CREATE TABLE social_worker_state (
  name TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The operator log is append-only and an attribution is never deleted, even
-- by the CLI's owner login, which grants do not restrict. Attributions take no
-- TRUNCATE guard: no runtime role may truncate, and a Mission Control reset
-- (`resetDatabase`) truncates profiles with CASCADE, which empties every
-- social table that references an account.
CREATE FUNCTION social_refuse_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are never %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER social_operator_log_append_only
BEFORE UPDATE OR DELETE ON social_operator_log
FOR EACH ROW EXECUTE FUNCTION social_refuse_rewrite();
CREATE TRIGGER social_operator_log_no_truncate
BEFORE TRUNCATE ON social_operator_log
FOR EACH STATEMENT EXECUTE FUNCTION social_refuse_rewrite();
CREATE TRIGGER social_attributions_kept
BEFORE DELETE ON social_attributions
FOR EACH ROW EXECUTE FUNCTION social_refuse_rewrite();

-- One callsign namespace across Mission Control profiles and social accounts.
-- Each table's trigger takes the callsign's transaction lock, then refuses a
-- callsign the other table or the reserved list holds. A concurrent writer of
-- the same callsign in the other table waits on the lock, and its check runs
-- after the first commits. The check must see that commit, so it needs READ
-- COMMITTED (a fresh snapshot per statement): a callsign write under a
-- transaction snapshot is refused rather than raced.
CREATE FUNCTION social_reject_taken_callsign()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.callsign IS NULL THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a callsign is written under READ COMMITTED only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('callsign:' || NEW.callsign));
  IF EXISTS (SELECT 1 FROM mission_control_reserved_callsigns WHERE callsign = NEW.callsign) THEN
    RAISE EXCEPTION 'callsign is reserved'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_callsign_not_reserved';
  END IF;
  IF TG_TABLE_NAME = 'social_accounts' THEN
    PERFORM 1 FROM mission_control_profiles WHERE callsign = NEW.callsign;
  ELSE
    PERFORM 1 FROM social_accounts WHERE callsign = NEW.callsign;
  END IF;
  IF FOUND THEN
    RAISE EXCEPTION 'callsign is taken'
      USING ERRCODE = 'unique_violation', CONSTRAINT = TG_TABLE_NAME || '_callsign_taken';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER social_accounts_callsign_guard
BEFORE INSERT OR UPDATE OF callsign ON social_accounts
FOR EACH ROW EXECUTE FUNCTION social_reject_taken_callsign();
-- Fires after 0003's `mission_control_profiles_reserved_callsign` (triggers run in name order).
CREATE TRIGGER mission_control_profiles_social_callsign_guard
BEFORE INSERT OR UPDATE OF callsign ON mission_control_profiles
FOR EACH ROW EXECUTE FUNCTION social_reject_taken_callsign();

-- Every wallet an account holds: its Mission Control linked wallets (through
-- its profile), its presale embedded wallet (through its own Privy DID or its
-- profile's Privy identity) and its own proven wallets. An address one account
-- reaches through several sources appears once, at its earliest link; an
-- address two accounts reach belongs to neither and is left out. The reader's
-- own grants apply (security_invoker).
CREATE VIEW social_wallet_owners WITH (security_invoker = true) AS
SELECT address, account_id, linked_at, source
FROM (
  SELECT
    linked.*,
    row_number() OVER (PARTITION BY address ORDER BY linked_at, source) AS rank,
    min(account_id::text) OVER (PARTITION BY address) = max(account_id::text) OVER (PARTITION BY address) AS sole
  FROM (
    SELECT w.sui_address AS address, a.account_id, w.verified_at AS linked_at, 'mission_control'::text AS source
    FROM mission_control_account_wallets w
    JOIN social_accounts a ON a.profile_id = w.profile_id
    UNION ALL
    SELECT e.address, a.account_id, e.resolved_at, 'presale_embedded'
    FROM presale_embedded_wallets e
    JOIN social_accounts a ON a.privy_did = e.privy_did
    UNION ALL
    SELECT e.address, a.account_id, e.resolved_at, 'presale_embedded'
    FROM presale_embedded_wallets e
    JOIN mission_control_account_identities i ON i.provider = 'privy' AND i.provider_subject = e.privy_did
    JOIN social_accounts a ON a.profile_id = i.profile_id
    UNION ALL
    SELECT address, account_id, verified_at, 'social'
    FROM social_account_wallets
  ) AS linked
) AS ranked
WHERE rank = 1 AND sole;

-- Grants. The web runtime (`blast_web`) reads everything and writes members'
-- own records; it never deletes a why or an attribution. The watcher
-- (`blast_watcher`) writes milestones, attributions, intents' resolution and
-- its cursors. The replica (`blast_replica`) reads the feed's relations. The
-- CLI runs as the migration login, which owns the tables.
REVOKE ALL ON TABLE
  social_accounts, social_account_wallets, social_follows, social_default_accounts, social_milestones,
  social_whys, social_why_reports, social_reactions, social_intents, social_attributions, social_config,
  social_blocked_terms, social_operator_log, social_worker_state, social_wallet_owners
FROM PUBLIC;

GRANT SELECT ON TABLE
  social_accounts, social_account_wallets, social_follows, social_default_accounts, social_milestones,
  social_whys, social_why_reports, social_reactions, social_intents, social_attributions, social_config,
  social_blocked_terms, social_operator_log, social_worker_state, social_wallet_owners
TO blast_web, blast_watcher;
GRANT INSERT, UPDATE ON TABLE
  social_accounts, social_account_wallets, social_whys, social_why_reports, social_intents
TO blast_web;
GRANT INSERT, UPDATE, DELETE ON TABLE social_follows, social_reactions TO blast_web;

GRANT INSERT, UPDATE ON TABLE social_milestones, social_attributions, social_worker_state TO blast_watcher;
GRANT INSERT ON TABLE social_whys TO blast_watcher;
GRANT INSERT, UPDATE, DELETE ON TABLE social_intents TO blast_watcher;

GRANT SELECT ON TABLE
  social_wallet_owners, social_accounts, social_account_wallets, social_follows, social_whys, social_reactions,
  social_attributions, social_milestones, social_config, social_default_accounts
TO blast_replica;

-- The wallet view's Mission Control and presale sources, for its other readers.
GRANT SELECT ON TABLE mission_control_account_wallets, mission_control_account_identities, presale_embedded_wallets
TO blast_watcher, blast_replica;
