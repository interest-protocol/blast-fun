-- Coin-scoped launchpad social records (modules/launchpad-social, spec §6.9),
-- apart from every chain table: a social row names its launch by ID and never
-- holds a chain fact (no price, lifecycle, balance or coin metadata). A
-- launch is canonical only while blast-infra's `chain_read_v1.pools` lists its
-- curve (`blast_curve:<launch_id>`); writes check it in their transaction and
-- public reads join it, so a social row can neither create nor revive a launch.
--
-- Length and count CHECKs here are safety ceilings, not product limits: the
-- provisional limits live in application configuration (launchpad-social
-- `limits.ts`) and change without a migration.

-- The durable identity behind each author, and the only place it is kept: a
-- Privy subject key (a keyed hash of the DID, never the DID) or a wallet proven
-- with a Wallet Proof. Posts carry only the opaque `author_identity_id`.
CREATE TABLE mission_control_launchpad_social_authors (
  author_identity_id UUID PRIMARY KEY,
  author_method TEXT NOT NULL CHECK (author_method IN ('privy', 'wallet_proof')),
  author_subject_key TEXT CHECK (author_subject_key ~ '^[0-9a-f]{64}$'),
  author_wallet TEXT CHECK (author_wallet ~ '^0x[0-9a-f]{64}$'),
  identity_key TEXT GENERATED ALWAYS AS (
    author_method || ':' || COALESCE(author_subject_key, author_wallet)
  ) STORED UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (author_method = 'privy' AND author_subject_key IS NOT NULL AND author_wallet IS NULL)
    OR (author_method = 'wallet_proof' AND author_wallet IS NOT NULL AND author_subject_key IS NULL)
  )
);

-- One immutable record per post version. A revision is a new record that
-- names the record it replaces (`revision_of`, at most once) and keeps the
-- post's thesis ID, launch, first-post time, kind and author, so a post keeps
-- its place in a launch's list. Only `visibility` and `visibility_changed_at`
-- ever change (column grants below): a hidden record keeps its author, text,
-- disclosure, provenance and audit trail. The disclosure is the author's text,
-- an optional disclosed wallet and the server's verification of it at a
-- holder snapshot's checkpoint and time. Provenance is the deployment and
-- committed checkpoint at which the launch was canonical when the record was
-- written; `created_at` is server time.
CREATE TABLE mission_control_launchpad_theses (
  record_id UUID PRIMARY KEY,
  thesis_id UUID NOT NULL,
  revision_of UUID UNIQUE,
  launch_id TEXT NOT NULL CHECK (launch_id ~ '^0x[0-9a-f]{64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('creator_thesis', 'creator_update', 'community_thesis')),
  stance TEXT CHECK (stance IN ('bullish', 'bearish', 'neutral')),
  author_identity_id UUID NOT NULL REFERENCES mission_control_launchpad_social_authors (author_identity_id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000 AND body = btrim(body)),
  evidence_links TEXT[] NOT NULL CHECK (
    cardinality(evidence_links) <= 32 AND array_position(evidence_links, NULL) IS NULL
    AND char_length(array_to_string(evidence_links, ' ')) <= 65536
    AND (cardinality(evidence_links) = 0 OR array_to_string(evidence_links, ' ') ~ '^https://\S+( https://\S+)*$')
  ),
  disclosure_text TEXT CHECK (char_length(disclosure_text) BETWEEN 1 AND 10000 AND disclosure_text = btrim(disclosure_text)),
  disclosure_wallet TEXT CHECK (disclosure_wallet ~ '^0x[0-9a-f]{64}$'),
  verification TEXT NOT NULL CHECK (verification IN ('verified_holder', 'not_holder', 'unavailable', 'not_requested')),
  observed_checkpoint BIGINT CHECK (observed_checkpoint >= 0),
  observed_at TIMESTAMPTZ,
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet', 'localnet')),
  deployment_fingerprint TEXT NOT NULL CHECK (deployment_fingerprint ~ '^[0-9a-f]{64}$'),
  launch_checkpoint BIGINT NOT NULL CHECK (launch_checkpoint >= 0),
  thesis_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'hidden')),
  visibility_changed_at TIMESTAMPTZ,
  UNIQUE (record_id, thesis_id, launch_id, thesis_created_at, kind, author_identity_id),
  -- A revision stays on its post's launch, kind and author, and keeps its first-post time.
  FOREIGN KEY (revision_of, thesis_id, launch_id, thesis_created_at, kind, author_identity_id)
    REFERENCES mission_control_launchpad_theses (record_id, thesis_id, launch_id, thesis_created_at, kind, author_identity_id),
  CHECK ((revision_of IS NULL) = (thesis_id = record_id)),
  CHECK (revision_of IS NOT NULL OR thesis_created_at = created_at),
  CHECK (thesis_created_at <= created_at),
  CHECK (stance IS NOT NULL OR kind = 'creator_update'),
  CHECK ((verification = 'not_requested') = (disclosure_wallet IS NULL)),
  CHECK ((verification IN ('verified_holder', 'not_holder')) = (observed_checkpoint IS NOT NULL)),
  CHECK ((observed_checkpoint IS NULL) = (observed_at IS NULL)),
  CHECK (visibility = 'public' OR visibility_changed_at IS NOT NULL)
);

-- A launch's public list: newest first post first, then thesis ID (the cursor).
CREATE INDEX mission_control_launchpad_theses_list_idx
  ON mission_control_launchpad_theses (launch_id, thesis_created_at DESC, thesis_id DESC)
  WHERE visibility = 'public';
-- A post's versions, for audit.
CREATE INDEX mission_control_launchpad_theses_thesis_idx
  ON mission_control_launchpad_theses (thesis_id, created_at);

-- Every visibility change, append-only: who changed which record, to what and why.
CREATE TABLE mission_control_launchpad_thesis_moderation (
  action_id UUID PRIMARY KEY,
  record_id UUID NOT NULL REFERENCES mission_control_launchpad_theses (record_id),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'hidden')),
  reason TEXT NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_-]{0,63}$'),
  moderator TEXT NOT NULL CHECK (moderator ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'),
  acted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX mission_control_launchpad_thesis_moderation_record_idx
  ON mission_control_launchpad_thesis_moderation (record_id, acted_at);

-- The search materialization: one row per public current record, written in
-- the transaction of the change it follows and removed when the record is
-- revised or hidden. It holds the record's normalized text (cut to the
-- configured length) and its launch ID, never a chain fact; search joins the
-- launch's identity from the chain views at read time.
CREATE TABLE mission_control_launchpad_search_documents (
  record_id UUID PRIMARY KEY REFERENCES mission_control_launchpad_theses (record_id),
  launch_id TEXT NOT NULL CHECK (launch_id ~ '^0x[0-9a-f]{64}$'),
  search_text TEXT NOT NULL CHECK (char_length(search_text) BETWEEN 1 AND 40000),
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, search_text)) STORED,
  materialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX mission_control_launchpad_search_documents_vector_idx
  ON mission_control_launchpad_search_documents USING GIN (search_vector);

-- The web runtime writes through the launchpad mutation guard and moderation;
-- the replica role reads the public post and search joins (never an author's
-- identity). Nobody deletes a post, an author or a moderation action, or edits
-- a record beyond its visibility.
REVOKE ALL ON TABLE
  mission_control_launchpad_social_authors,
  mission_control_launchpad_theses,
  mission_control_launchpad_thesis_moderation,
  mission_control_launchpad_search_documents
FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE mission_control_launchpad_social_authors TO blast_web;
GRANT SELECT, INSERT ON TABLE mission_control_launchpad_theses TO blast_web;
GRANT UPDATE (visibility, visibility_changed_at) ON TABLE mission_control_launchpad_theses TO blast_web;
GRANT SELECT, INSERT ON TABLE mission_control_launchpad_thesis_moderation TO blast_web;
GRANT SELECT, INSERT, DELETE ON TABLE mission_control_launchpad_search_documents TO blast_web;
GRANT SELECT ON TABLE mission_control_launchpad_theses, mission_control_launchpad_search_documents TO blast_replica;
