-- Representation-only migration. Full-body offline preflight is mandatory for
-- retained data; see docs/architecture/recipient-draft-migration.md. The normal
-- migration runner wraps this file and its checksum ledger entry in one transaction.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
-- Take the final DDL lock before reading: a read-then-write transaction must
-- finish before this migration starts, rather than deadlock on a later upgrade.
LOCK TABLE social_presale_drafts IN ACCESS EXCLUSIVE MODE;

-- Stage every changed body before updating any durable row. No conversion
-- function or trigger survives this one-time migration.
CREATE TEMP TABLE recipient_draft_0130_stage (
  draft_id UUID PRIMARY KEY,
  before_body JSONB NOT NULL,
  after_body JSONB NOT NULL,
  protected_columns JSONB NOT NULL
) ON COMMIT DROP;

DO $$
DECLARE
  draft RECORD;
  field TEXT;
  recipient JSONB;
  patched JSONB;
  recipients JSONB;
  body_after JSONB;
  old_shape BOOLEAN;
  keys TEXT[];
  amount_key TEXT;
  amount NUMERIC;
BEGIN
  FOR draft IN SELECT d.draft_id, d.body, to_jsonb(d) - 'body' AS protected_columns
               FROM social_presale_drafts d ORDER BY d.draft_id
  LOOP
    body_after := draft.body;
    FOREACH field IN ARRAY ARRAY['token_recipients', 'raise_recipients'] LOOP
      IF jsonb_typeof(draft.body -> field) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'recipient draft migration refused: invalid array';
      END IF;
      IF jsonb_array_length(draft.body -> field) > 64 THEN
        RAISE EXCEPTION 'recipient draft migration refused: array limit';
      END IF;
      recipients := '[]'::jsonb;
      FOR recipient IN SELECT value FROM jsonb_array_elements(draft.body -> field) LOOP
        IF jsonb_typeof(recipient) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'recipient draft migration refused: invalid row';
        END IF;
        old_shape := recipient ? 'cliff_months' OR recipient ? 'months';
        keys := CASE WHEN old_shape
          THEN ARRAY['label', 'address', 'bps', 'vest', 'cliff_months', 'months']
          ELSE ARRAY['label', 'address', 'bps', 'vest', 'cliff', 'duration'] END;
        IF NOT recipient ?& keys
           OR (recipient - keys - CASE WHEN old_shape THEN ARRAY[]::text[]
                                      ELSE ARRAY['cliff_unit', 'duration_unit'] END) <> '{}'::jsonb THEN
          RAISE EXCEPTION 'recipient draft migration refused: ambiguous or unknown row keys';
        END IF;
        IF jsonb_typeof(recipient -> 'label') IS DISTINCT FROM 'string'
           OR jsonb_typeof(recipient -> 'address') IS DISTINCT FROM 'string'
           OR jsonb_typeof(recipient -> 'vest') IS DISTINCT FROM 'boolean' THEN
          RAISE EXCEPTION 'recipient draft migration refused: invalid row scalar';
        END IF;
        -- Match JS code-point length and its exact C0/DEL exclusion, not a
        -- locale-dependent character class that would also reject C1 values.
        IF char_length(recipient ->> 'label') > 20
           OR char_length(recipient ->> 'address') > 66
           OR (recipient ->> 'label') ~ U&'[\0001-\001F\007F]'
           OR (recipient ->> 'address') ~ U&'[\0001-\001F\007F]' THEN
          RAISE EXCEPTION 'recipient draft migration refused: invalid row text';
        END IF;
        FOREACH amount_key IN ARRAY CASE WHEN old_shape
          THEN ARRAY['bps', 'cliff_months', 'months'] ELSE ARRAY['bps', 'cliff', 'duration'] END
        LOOP
          IF jsonb_typeof(recipient -> amount_key) IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'recipient draft migration refused: invalid integer';
          END IF;
          amount := (recipient ->> amount_key)::numeric;
          IF amount < 0 OR amount <> trunc(amount)
             OR amount > (CASE WHEN amount_key = 'bps' THEN 1000000 ELSE 9007199254740991 END) THEN
            RAISE EXCEPTION 'recipient draft migration refused: integer out of range';
          END IF;
        END LOOP;
        IF NOT old_shape THEN
          FOREACH amount_key IN ARRAY ARRAY['cliff_unit', 'duration_unit'] LOOP
            IF recipient ? amount_key AND (
              jsonb_typeof(recipient -> amount_key) IS DISTINCT FROM 'string'
              OR (recipient ->> amount_key) NOT IN ('months', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds')
            ) THEN
              RAISE EXCEPTION 'recipient draft migration refused: invalid unit';
            END IF;
          END LOOP;
        END IF;
        patched := CASE WHEN old_shape THEN
          (recipient - ARRAY['cliff_months', 'months']) || jsonb_build_object(
            'cliff', recipient -> 'cliff_months', 'duration', recipient -> 'months',
            'cliff_unit', 'months', 'duration_unit', 'months')
          ELSE recipient END;
        recipients := recipients || jsonb_build_array(patched);
      END LOOP;
      body_after := jsonb_set(body_after, ARRAY[field], recipients, false);
    END LOOP;
    IF octet_length(body_after::text) > 65536 THEN
      RAISE EXCEPTION 'recipient draft migration refused: transformed body limit';
    END IF;
    IF body_after IS DISTINCT FROM draft.body THEN
      INSERT INTO recipient_draft_0130_stage VALUES
        (draft.draft_id, draft.body, body_after, draft.protected_columns);
    END IF;
  END LOOP;
END;
$$;

UPDATE social_presale_drafts d SET body = s.after_body
FROM recipient_draft_0130_stage s
WHERE d.draft_id = s.draft_id AND d.body = s.before_body;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM recipient_draft_0130_stage s
    LEFT JOIN social_presale_drafts d ON d.draft_id = s.draft_id
    WHERE d.draft_id IS NULL OR d.body IS DISTINCT FROM s.after_body
       OR (to_jsonb(d) - 'body') IS DISTINCT FROM s.protected_columns
  ) THEN
    RAISE EXCEPTION 'recipient draft migration refused: preservation mismatch';
  END IF;
END;
$$;

-- A narrow stale-writer guard, not another full draft parser or converter.
-- Canonical request validation still belongs to the application.
ALTER TABLE social_presale_drafts
  ADD CONSTRAINT social_presale_drafts_canonical_recipients CHECK (
    NOT jsonb_path_exists(body, '$.token_recipients[*] ? (exists (@.cliff_months) || exists (@.months))')
    AND NOT jsonb_path_exists(body, '$.raise_recipients[*] ? (exists (@.cliff_months) || exists (@.months))')
  );
