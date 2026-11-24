-- LP-21 / LP-19: the daily holder-rewards pipeline serves graduated launches' vaults
-- (`blast_fun_migrators::blast_holder_rewards`) beside presale vaults, with one policy and shared
-- tables. Every change is additive for presale rows: each new column defaults to the presale value,
-- and presale constraints keep their meaning.
--
-- * `presale_daily_vaults.vault_kind`: which contract a vault's rounds use. Launch periods, plans
--   and actions are scoped by their own deployment fingerprint, so presale queries never see them.
-- * Launch budgets are Meme and Quote (the vault keeps both shares), so allocations, plans and
--   reservations gain a Meme amount; a leaf needs one positive amount, as `claim` requires.
-- * A launch round has no claim deadline, treasury or gas reserve: the execution row leaves both
--   null. Presale executions still always set them (enforced by kind below).
-- * The launch key signs under its own outbox role, `launchpad-rewards`.
-- * `launch_published_daily_manifest` serves the public manifest route for launch rounds. It reads
--   blast-infra's `chain_read_v1.launch_reward_rounds` (docs/launchpad/rewards.md).

ALTER TABLE presale_daily_vaults
  ADD COLUMN vault_kind TEXT NOT NULL DEFAULT 'presale' CHECK (vault_kind IN ('presale','launch'));

CREATE OR REPLACE FUNCTION presale_daily_period_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='presale_daily_vaults' THEN
    IF NEW.network<>OLD.network OR NEW.deployment_fingerprint<>OLD.deployment_fingerprint OR NEW.vault_id<>OLD.vault_id
      OR NEW.vault_kind<>OLD.vault_kind
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

ALTER TABLE presale_daily_allocations
  ADD COLUMN meme_amount NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (meme_amount BETWEEN 0 AND 18446744073709551615);
ALTER TABLE presale_daily_allocations DROP CONSTRAINT presale_daily_allocations_quote_amount_check;
ALTER TABLE presale_daily_allocations
  ADD CONSTRAINT presale_daily_allocations_quote_amount_check CHECK (quote_amount BETWEEN 0 AND 18446744073709551615),
  ADD CONSTRAINT presale_daily_allocations_positive CHECK (meme_amount + quote_amount > 0);

ALTER TABLE presale_daily_plans
  ADD COLUMN meme_holder NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (meme_holder BETWEEN 0 AND 18446744073709551615),
  ADD COLUMN meme_allocated NUMERIC(20,0) NOT NULL DEFAULT 0,
  ADD COLUMN meme_dust NUMERIC(20,0),
  ADD CONSTRAINT presale_daily_plans_meme_allocated CHECK (meme_allocated BETWEEN 0 AND meme_holder),
  ADD CONSTRAINT presale_daily_plans_meme_dust CHECK (meme_dust = meme_holder - meme_allocated);

CREATE OR REPLACE FUNCTION presale_daily_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'presale_daily_plans' THEN
    IF (OLD.stage = 'ready' AND NEW.stage NOT IN ('ready','funded','cancelled'))
       OR (OLD.stage IN ('funded','cancelled') AND NEW.stage <> OLD.stage) THEN
      RAISE EXCEPTION 'terminal plan cannot return to preparation';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['stage','allocation_cursor','allocated_weight','allocated','dust','meme_allocated','meme_dust','positive_leaves','manifest','storage_url','storage_hash','storage_verified_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['stage','allocation_cursor','allocated_weight','allocated','dust','meme_allocated','meme_dust','positive_leaves','manifest','storage_url','storage_hash','storage_verified_at'])
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
       OR NEW.quote_amount IS DISTINCT FROM OLD.quote_amount OR NEW.meme_amount IS DISTINCT FROM OLD.meme_amount OR (OLD.proof IS NOT NULL AND NEW.proof IS DISTINCT FROM OLD.proof) THEN
      RAISE EXCEPTION 'daily allocation is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE presale_quote_reservations
  ADD COLUMN meme_amount NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (meme_amount BETWEEN 0 AND 18446744073709551615);
ALTER TABLE presale_quote_reservations DROP CONSTRAINT presale_quote_reservations_amount_check;
ALTER TABLE presale_quote_reservations
  ADD CONSTRAINT presale_quote_reservations_amount_check CHECK (amount BETWEEN 0 AND 18446744073709551615),
  ADD CONSTRAINT presale_quote_reservations_positive CHECK (amount + meme_amount > 0);

ALTER TABLE presale_daily_executions ALTER COLUMN claim_deadline_ms DROP NOT NULL, ALTER COLUMN treasury DROP NOT NULL;
-- A presale execution keeps both; only a launch vault's execution may omit them.
CREATE FUNCTION presale_daily_execution_kind() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE kind TEXT;
BEGIN
  SELECT v.vault_kind INTO kind FROM presale_daily_plans p JOIN presale_daily_periods d USING(period_id)
    JOIN presale_daily_vaults v USING(network,deployment_fingerprint,vault_id) WHERE p.plan_id=NEW.plan_id;
  IF kind IS NULL OR (kind='launch') <> (NEW.claim_deadline_ms IS NULL AND NEW.treasury IS NULL)
    OR (NEW.claim_deadline_ms IS NULL) <> (NEW.treasury IS NULL) THEN
    RAISE EXCEPTION 'daily execution deadline and treasury do not match its vault kind';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER presale_daily_execution_kind BEFORE INSERT ON presale_daily_executions
  FOR EACH ROW EXECUTE FUNCTION presale_daily_execution_kind();
REVOKE ALL ON FUNCTION presale_daily_execution_kind() FROM PUBLIC;

ALTER TABLE presale_outbox_actions DROP CONSTRAINT presale_outbox_actions_role_check;
ALTER TABLE presale_outbox_actions ADD CONSTRAINT presale_outbox_actions_role_check
  CHECK (role IN ('presale-lifecycle','presale-rewards','launchpad-rewards'));
-- The launch key publishes, delivers and collects; it never settles gas or closes a round.
ALTER TABLE presale_outbox_actions ADD CONSTRAINT presale_outbox_actions_launch_kinds
  CHECK (role <> 'launchpad-rewards' OR kind IN ('collect_fees','publish_reward','claim_reward'));

CREATE FUNCTION launch_published_daily_manifest(target_round TEXT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE result TEXT;
BEGIN
  IF target_round IS NULL OR target_round !~ '^0x[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  SELECT p.storage_url INTO result FROM presale_daily_executions x
  JOIN presale_daily_plans p USING(plan_id) JOIN presale_daily_periods d USING(period_id)
  JOIN presale_daily_vaults v USING(network,deployment_fingerprint,vault_id)
  JOIN chain_read_v1.launch_reward_rounds r ON r.round_id=x.round_id
  WHERE x.round_id=target_round AND v.vault_kind='launch' AND p.stage='funded' AND p.storage_verified_at IS NOT NULL
    AND r.vault_id=p.manifest->>'vaultId' AND r.number::text=p.manifest->>'number'
    AND r.start_checkpoint::text=p.manifest->>'startCheckpoint'
    AND r.end_checkpoint::text=p.manifest->>'endCheckpoint'
    AND r.root=p.manifest->>'root' AND r.manifest_digest=p.manifest->>'manifestDigest'
    AND r.leaf_count::text=p.manifest->>'leafCount'
    AND r.meme_amount=p.meme_allocated AND r.quote_amount=p.allocated
    AND r.published_tx_digest=x.publish_digest AND r.published_checkpoint=x.publication_checkpoint;
  RETURN result;
END $$;
-- Owned by blast_indexer like `presale_published_daily_manifest`. A new owner needs CREATE on the
-- schema, which blast-infra's engine-schema migration (2026-10-16) revoked from blast_indexer; the
-- grant lasts only for this transaction, and a role that already has it keeps it.
DO $$
DECLARE had_create BOOLEAN := has_schema_privilege('blast_indexer', 'public', 'CREATE');
BEGIN
  IF NOT had_create THEN GRANT CREATE ON SCHEMA public TO blast_indexer; END IF;
  ALTER FUNCTION launch_published_daily_manifest(TEXT) OWNER TO blast_indexer;
  IF NOT had_create THEN REVOKE CREATE ON SCHEMA public FROM blast_indexer; END IF;
END $$;
REVOKE ALL ON FUNCTION launch_published_daily_manifest(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION launch_published_daily_manifest(TEXT) TO blast_web,blast_replica;
