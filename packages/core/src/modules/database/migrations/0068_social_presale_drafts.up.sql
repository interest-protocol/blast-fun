-- Social feed UI-20 (the live canonical UI's Create): an account's presale
-- drafts, saved as the creator types so they survive a reload, a crash or
-- another device, and read back to publish.
--
-- One row per draft. The client picks `draft_id` (a UUID) before the first
-- save, so a retried create is harmless. `version` counts saves: every save
-- names the version it edited and only that version is replaced
-- (optimistic concurrency), so two tabs cannot silently overwrite each
-- other. `body` is exactly what the creator edits, read strictly by
-- `create/model.ts` `parseDraft` before it is stored; `logo_url` (the coin's
-- image in the public launch-asset store) and `allowlist` (the summary of an
-- allowlist the same sign-in uploaded through `/api/presale/allowlists`,
-- read by the server) are written only by the server.
--
-- Drafts hold no chain state and nothing secret; publishing is a separate
-- plan the creator's wallet signs (`create/publish.ts`).
CREATE TABLE social_presale_drafts (
  draft_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  version INTEGER NOT NULL CHECK (version >= 1),
  body JSONB NOT NULL CHECK (jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 65536),
  logo_url TEXT CHECK (char_length(logo_url) <= 2048 AND logo_url ~ '^https://[^[:space:]]+$'),
  allowlist JSONB CHECK (allowlist IS NULL OR (jsonb_typeof(allowlist) = 'object' AND octet_length(allowlist::text) <= 1024)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The drafts list: most recently saved first, keyset (updated_at, draft_id),
-- and the per-account count the draft limit reads.
CREATE INDEX social_presale_drafts_account_idx ON social_presale_drafts (account_id, updated_at DESC, draft_id DESC);

-- The web runtime is the only reader and writer, always keyed by the
-- account the route kit resolved; the replica and the workers read none.
REVOKE ALL ON TABLE social_presale_drafts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE social_presale_drafts TO blast_web;
