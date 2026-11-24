DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM social_swap_receipts) THEN
    RAISE EXCEPTION 'Cannot remove frontend swap tracking while receipts exist';
  END IF;
END $$;
DROP TABLE social_swap_receipts;
DROP INDEX social_swap_intents_tracking_idx;
ALTER TABLE social_swap_intents DROP COLUMN track_receipt;
