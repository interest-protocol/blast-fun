-- Social feed UI-09/10 (canonical UI §10, the sale page): a sale's theses
-- (the active whys on its commits) by presale, without scanning the sale's
-- every commit. A why is written on an activity entry ('a:<activity_id>');
-- its sale is that activity row's `presale_id` in blast-infra's
-- `chain_read_v1.activity`, which never changes for an activity id. The
-- column is filled when the why is written (the trigger reads the entry's
-- row by its activity-id parts, the view's key) and for existing rows below.
-- Whys on other entries keep it null. The sale page reads
-- `social_whys_presale_active_idx`.
--
-- The trigger runs with the writer's rights: `blast_web` and
-- `blast_watcher`, the roles that insert whys, may read the view.

ALTER TABLE social_whys
  ADD COLUMN presale_id TEXT CONSTRAINT social_whys_presale_id CHECK (presale_id ~ '^0x[0-9a-f]{64}$');

CREATE FUNCTION social_whys_presale_of(entry_id TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT a.presale_id
  FROM chain_read_v1.activity a
  WHERE entry_id ~ '^a:[0-9]+:[0-9]+:[0-9]+:[0-9]+$'
    AND a.checkpoint = split_part(entry_id, ':', 2)::bigint
    AND a.tx_slot = split_part(entry_id, ':', 3)::integer
    AND a.event_slot = split_part(entry_id, ':', 4)::integer
    AND a.part = split_part(entry_id, ':', 5)::integer
$$;

CREATE FUNCTION social_whys_set_presale()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.presale_id IS NULL THEN
    NEW.presale_id := social_whys_presale_of(NEW.entry_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER social_whys_presale
BEFORE INSERT ON social_whys
FOR EACH ROW EXECUTE FUNCTION social_whys_set_presale();

UPDATE social_whys SET presale_id = social_whys_presale_of(entry_id) WHERE presale_id IS NULL;

CREATE INDEX social_whys_presale_active_idx ON social_whys (presale_id, entry_id) WHERE state = 'active' AND presale_id IS NOT NULL;
