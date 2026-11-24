-- Launch (`/launch`): each account's bonding-curve launch drafts, autosaved
-- like `social_presale_drafts` (0068), and the published launch's details.
-- The client picks `draft_id`; `version` is the optimistic-concurrency
-- counter every save, logo and cover change advances.
--
-- `coin_type` is set once, by the first publish step after the coin's own
-- package (registration names it): a draft whose coin exists never builds a
-- second coin, whichever device resumes it. `published_launch_id` is set
-- once, by `…/published`; from then on the row is the launch's off-chain
-- details (tagline, links, cover) the coin page reads by launch id.
CREATE TABLE social_launch_drafts (
  draft_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  version INTEGER NOT NULL CHECK (version >= 1),
  body JSONB NOT NULL CHECK (jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 16384),
  logo_url TEXT CHECK (char_length(logo_url) <= 2048 AND logo_url ~ '^https://[^[:space:]]+$'),
  cover_key TEXT CHECK (cover_key ~ '^draft-covers/[0-9a-f-]{36}/[0-9a-f]{64}\.webp$'),
  cover_url TEXT CHECK (char_length(cover_url) <= 2048 AND cover_url ~ '^https://[^[:space:]]+$'),
  cover_width INTEGER CHECK (cover_width BETWEEN 1 AND 8192),
  cover_height INTEGER CHECK (cover_height BETWEEN 1 AND 8192),
  cover_source_width INTEGER CHECK (cover_source_width BETWEEN 1 AND 8192),
  cover_source_height INTEGER CHECK (cover_source_height BETWEEN 1 AND 8192),
  publication JSONB CHECK (publication IS NULL OR jsonb_typeof(publication) = 'object'),
  coin_type TEXT CHECK (char_length(coin_type) <= 512 AND coin_type ~ '^0x[0-9a-f]{64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$'),
  published_launch_id TEXT CHECK (published_launch_id ~ '^0x[0-9a-f]{64}$'),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT social_launch_drafts_cover CHECK (num_nulls(cover_key, cover_url, cover_width, cover_height) IN (0, 4)),
  CONSTRAINT social_launch_drafts_cover_source CHECK (
    num_nulls(cover_source_width, cover_source_height) IN (0, 2)
    AND (cover_source_width IS NULL OR cover_key IS NOT NULL)
  ),
  CONSTRAINT social_launch_drafts_published CHECK ((published_launch_id IS NULL) = (published_at IS NULL)),
  CONSTRAINT social_launch_drafts_published_coin CHECK (published_launch_id IS NULL OR coin_type IS NOT NULL)
);
CREATE INDEX social_launch_drafts_account_idx ON social_launch_drafts (account_id, updated_at DESC, draft_id DESC);
CREATE UNIQUE INDEX social_launch_drafts_published_idx ON social_launch_drafts (published_launch_id) WHERE published_launch_id IS NOT NULL;

-- The web runtime is the only reader and writer; the replica and the workers read none.
REVOKE ALL ON TABLE social_launch_drafts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE social_launch_drafts TO blast_web;
