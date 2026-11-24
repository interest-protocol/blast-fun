-- Social feed UI-13 (canonical UI §13, Notifications; owner decision OA-11):
-- one row per notification per recipient, written by the social worker
-- (`npm run social:worker`, role `blast_watcher`) and read and marked read by
-- the web runtime for the signed-in account only.
--
-- Fan-out on write: the worker inserts one row for each recipient when the
-- chain event is seen (a followed account's commit, a fill milestone, a
-- lifecycle change, an upcoming open, close or unlock). Reads are then one
-- index range per account: the page, the unread count and mark-read never
-- join chain activity against follows (COORDINATION.md "UI-13 Notifications
-- record" has the EXPLAIN numbers behind the choice).
--
-- A row references chain identity (`presale_id`, `entry_id`) and keeps only
-- the figures its message states at the event (`data`, a small JSON object);
-- names, marks and live figures are joined at read time, so a rename or a
-- privacy change applies to old notifications too.
--
-- Idempotent generation: `source_key` names the source event (for example
-- `follow:<activity_id>`, `fill:<presale>:participants:1000`,
-- `funded:<presale>`), unique per recipient, so a rerun, a restart or a
-- replay inserts nothing twice (`ON CONFLICT DO NOTHING`).
--
-- Retention: the worker deletes rows whose event is older than
-- `SOCIAL_NOTIFICATION_RETENTION_DAYS` (90 by default), in batches.
CREATE TABLE social_notifications (
  notification_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  kind TEXT NOT NULL CHECK (kind IN ('fill', 'follow', 'claim', 'funded', 'soon', 'unlock')),
  source_key TEXT NOT NULL CHECK (source_key ~ '^[a-z]+:[A-Za-z0-9:_.-]{1,200}$'),
  presale_id TEXT NOT NULL CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  -- The followed account that acted (`follow` only).
  actor_account_id UUID REFERENCES social_accounts (account_id),
  -- The feed entry the notification came from, when there is one (`a:<activity_id>`, `l:<presale>:<state>`).
  entry_id TEXT CHECK (char_length(entry_id) BETWEEN 1 AND 200),
  occurred_at_ms BIGINT NOT NULL CHECK (occurred_at_ms >= 0),
  data JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 1024),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  CONSTRAINT social_notifications_follow_actor CHECK ((kind = 'follow') = (actor_account_id IS NOT NULL)),
  CONSTRAINT social_notifications_source UNIQUE (account_id, source_key)
);

-- The page: newest event first, keyset (occurred_at_ms, notification_id).
CREATE INDEX social_notifications_page_idx ON social_notifications (account_id, occurred_at_ms DESC, notification_id DESC);
-- The unread count: rows not marked read one by one, above the account's read watermark.
CREATE INDEX social_notifications_unread_idx ON social_notifications (account_id, notification_id) WHERE read_at IS NULL;
-- Retention deletes the oldest events first.
CREATE INDEX social_notifications_retention_idx ON social_notifications (occurred_at_ms);

-- "Mark all as read": the account's read watermark. Every notification of the
-- account with an id at or below `read_through` reads as read, so marking all
-- read is one row whatever the unread count; a notification the worker
-- inserts later gets a higher id and stays unread. One row is marked read by
-- setting its `read_at`.
CREATE TABLE social_notification_reads (
  account_id UUID PRIMARY KEY REFERENCES social_accounts (account_id),
  read_through BIGINT NOT NULL CHECK (read_through >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The web runtime reads an account's rows and marks them read (its only
-- UPDATE, `notifications/store.ts`; social grants are table-level); the
-- watcher inserts and deletes (retention). The replica reads none of them.
REVOKE ALL ON TABLE social_notifications FROM PUBLIC;
GRANT SELECT, UPDATE ON TABLE social_notifications TO blast_web;
GRANT SELECT, INSERT, DELETE ON TABLE social_notifications TO blast_watcher;
REVOKE ALL ON TABLE social_notification_reads FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE social_notification_reads TO blast_web;
