-- Rollback is allowed only before any launch vault, launch action or Meme reward exists: it would
-- otherwise discard financial history.
DO $$
BEGIN
  IF EXISTS (SELECT FROM presale_daily_vaults WHERE vault_kind <> 'presale')
    OR EXISTS (SELECT FROM presale_outbox_actions WHERE role = 'launchpad-rewards')
    OR EXISTS (SELECT FROM presale_daily_allocations WHERE meme_amount <> 0 OR quote_amount = 0)
    OR EXISTS (SELECT FROM presale_quote_reservations WHERE meme_amount <> 0 OR amount = 0)
    OR EXISTS (SELECT FROM presale_daily_executions WHERE claim_deadline_ms IS NULL OR treasury IS NULL) THEN
    RAISE EXCEPTION '0138 rollback would discard launch holder-reward history';
  END IF;
END $$;

DROP FUNCTION launch_published_daily_manifest(TEXT);
ALTER TABLE presale_outbox_actions DROP CONSTRAINT presale_outbox_actions_launch_kinds;
ALTER TABLE presale_outbox_actions DROP CONSTRAINT presale_outbox_actions_role_check;
ALTER TABLE presale_outbox_actions ADD CONSTRAINT presale_outbox_actions_role_check
  CHECK (role IN ('presale-lifecycle','presale-rewards'));

DROP TRIGGER presale_daily_execution_kind ON presale_daily_executions;
DROP FUNCTION presale_daily_execution_kind();
ALTER TABLE presale_daily_executions ALTER COLUMN claim_deadline_ms SET NOT NULL, ALTER COLUMN treasury SET NOT NULL;

ALTER TABLE presale_quote_reservations DROP CONSTRAINT presale_quote_reservations_positive;
ALTER TABLE presale_quote_reservations DROP CONSTRAINT presale_quote_reservations_amount_check;
ALTER TABLE presale_quote_reservations
  ADD CONSTRAINT presale_quote_reservations_amount_check CHECK (amount BETWEEN 1 AND 18446744073709551615);
ALTER TABLE presale_quote_reservations DROP COLUMN meme_amount;

CREATE OR REPLACE FUNCTION presale_daily_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'presale_daily_plans' THEN
    IF (OLD.stage = 'ready' AND NEW.stage NOT IN ('ready','funded','cancelled'))
       OR (OLD.stage IN ('funded','cancelled') AND NEW.stage <> OLD.stage) THEN
      RAISE EXCEPTION 'terminal plan cannot return to preparation';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['stage','allocation_cursor','allocated_weight','allocated','dust','positive_leaves','manifest','storage_url','storage_hash','storage_verified_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['stage','allocation_cursor','allocated_weight','allocated','dust','positive_leaves','manifest','storage_url','storage_hash','storage_verified_at'])
       OR (OLD.stage IN ('ready','funded','cancelled') AND (to_jsonb(NEW) - 'stage') IS DISTINCT FROM (to_jsonb(OLD) - 'stage')) THEN
      RAISE EXCEPTION 'daily plan inputs and ready commitments are immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'presale_quote_reservations' THEN
    IF (to_jsonb(NEW) - ARRAY['state','funded_checkpoint','funded_digest']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['state','funded_checkpoint','funded_digest'])
       OR OLD.state = 'released' OR (OLD.state = 'funded' AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'quote reservation ownership is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'presale_daily_hashes' THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'daily hash is immutable'; END IF;
  ELSE
    IF NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.leaf_index IS DISTINCT FROM OLD.leaf_index
       OR NEW.beneficiary IS DISTINCT FROM OLD.beneficiary OR NEW.weight IS DISTINCT FROM OLD.weight
       OR NEW.quote_amount IS DISTINCT FROM OLD.quote_amount OR (OLD.proof IS NOT NULL AND NEW.proof IS DISTINCT FROM OLD.proof) THEN
      RAISE EXCEPTION 'daily allocation is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE presale_daily_plans DROP COLUMN meme_dust, DROP COLUMN meme_allocated, DROP COLUMN meme_holder;

ALTER TABLE presale_daily_allocations DROP CONSTRAINT presale_daily_allocations_positive;
ALTER TABLE presale_daily_allocations DROP CONSTRAINT presale_daily_allocations_quote_amount_check;
ALTER TABLE presale_daily_allocations
  ADD CONSTRAINT presale_daily_allocations_quote_amount_check CHECK (quote_amount BETWEEN 1 AND 18446744073709551615);
ALTER TABLE presale_daily_allocations DROP COLUMN meme_amount;

CREATE OR REPLACE FUNCTION presale_daily_period_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='presale_daily_vaults' THEN
    IF NEW.network<>OLD.network OR NEW.deployment_fingerprint<>OLD.deployment_fingerprint OR NEW.vault_id<>OLD.vault_id
      OR NEW.anchor_ms<>OLD.anchor_ms OR NEW.next_period<OLD.next_period OR NEW.next_round<OLD.next_round
      OR NEW.budget_generation<OLD.budget_generation THEN
      RAISE EXCEPTION 'daily vault identity and progress cannot regress';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['status','reason','selected_price','closing_price','input_cut','input_hash','evaluation_inputs',
      'qualification_cursor','qualification_complete','price_search_checkpoint','admin_reserve','reserve_evidence','decision_evidence','qualifiers','global_weight'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','reason','selected_price','closing_price','input_cut','input_hash','evaluation_inputs',
      'qualification_cursor','qualification_complete','price_search_checkpoint','admin_reserve','reserve_evidence','decision_evidence','qualifiers','global_weight'])
      OR (OLD.evaluation_inputs IS NOT NULL AND (NEW.evaluation_inputs IS DISTINCT FROM OLD.evaluation_inputs
        OR NEW.input_cut IS DISTINCT FROM OLD.input_cut OR NEW.input_hash<>OLD.input_hash))
      OR (NEW.decision_evidence IS DISTINCT FROM OLD.decision_evidence AND (OLD.decision_evidence IS NOT NULL OR NEW.status<>'skipped'))
      OR (OLD.selected_price IS NOT NULL AND NEW.selected_price IS DISTINCT FROM OLD.selected_price)
      OR (OLD.closing_price IS NOT NULL AND NEW.closing_price IS DISTINCT FROM OLD.closing_price)
      OR (OLD.admin_reserve IS NOT NULL AND (NEW.admin_reserve IS DISTINCT FROM OLD.admin_reserve OR NEW.reserve_evidence IS DISTINCT FROM OLD.reserve_evidence))
      OR (OLD.qualifiers IS NOT NULL AND (NEW.qualifiers IS NULL OR NEW.qualifiers<OLD.qualifiers))
      OR (OLD.global_weight IS NOT NULL AND (NEW.global_weight IS NULL OR NEW.global_weight<OLD.global_weight))
      OR (OLD.qualification_cursor IS NOT NULL AND (NEW.qualification_cursor IS NULL OR NEW.qualification_cursor COLLATE "C"<OLD.qualification_cursor COLLATE "C"))
      OR (OLD.price_search_checkpoint IS NOT NULL AND (NEW.price_search_checkpoint IS NULL OR NEW.price_search_checkpoint<OLD.price_search_checkpoint))
      OR (OLD.qualification_complete AND (NOT NEW.qualification_complete OR NEW.qualifiers IS DISTINCT FROM OLD.qualifiers
        OR NEW.global_weight IS DISTINCT FROM OLD.global_weight OR NEW.qualification_cursor IS DISTINCT FROM OLD.qualification_cursor))
      OR (OLD.status IN ('skipped','funded') AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'daily period identity, decisions and completed qualification are immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE presale_daily_vaults DROP COLUMN vault_kind;
