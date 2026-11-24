-- Infra's keyless planner owns entitlement and custody decisions; executors only read them.
CREATE TABLE presale_daily_vaults (
  network TEXT NOT NULL,
  deployment_fingerprint TEXT NOT NULL CHECK (deployment_fingerprint ~ '^[0-9a-f]{64}$'),
  vault_id TEXT NOT NULL CHECK (vault_id ~ '^0x[0-9a-f]{64}$'),
  anchor_ms NUMERIC(20,0) NOT NULL CHECK (anchor_ms >= 0),
  next_period BIGINT NOT NULL DEFAULT 0 CHECK (next_period >= 0),
  last_planned_at TIMESTAMPTZ,
  next_round NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (next_round BETWEEN 0 AND 18446744073709551615),
  last_end_checkpoint NUMERIC(20,0),
  budget_generation BIGINT NOT NULL DEFAULT 0 CHECK (budget_generation >= 0),
  saved_price JSONB CHECK (jsonb_typeof(saved_price) = 'object'),
  PRIMARY KEY(network,deployment_fingerprint,vault_id),
  UNIQUE(network,vault_id)
);
CREATE TABLE presale_daily_periods (
  period_id UUID PRIMARY KEY,
  network TEXT NOT NULL,
  deployment_fingerprint TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  start_ms NUMERIC(20,0) NOT NULL CHECK (start_ms >= 0),
  end_ms NUMERIC(20,0) NOT NULL CHECK (end_ms = start_ms + 86400000),
  status TEXT NOT NULL CHECK (status IN ('waiting_price','blocked','staging','ready','funded','skipped')),
  reason TEXT,
  selected_price JSONB CHECK (jsonb_typeof(selected_price) = 'object'),
  closing_price JSONB CHECK (jsonb_typeof(closing_price) = 'object'),
  input_cut JSONB NOT NULL CHECK (jsonb_typeof(input_cut) = 'object'),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  evaluation_inputs JSONB CHECK (jsonb_typeof(evaluation_inputs) = 'object'),
  qualification_cursor TEXT CHECK (qualification_cursor ~ '^0x[0-9a-f]{64}$'),
  qualification_complete BOOLEAN NOT NULL DEFAULT FALSE,
  price_search_checkpoint BIGINT CHECK (price_search_checkpoint >= 0),
  admin_reserve NUMERIC(20,0) CHECK (admin_reserve BETWEEN 0 AND 18446744073709551615),
  reserve_evidence JSONB CHECK (jsonb_typeof(reserve_evidence) = 'object'),
  decision_evidence JSONB CHECK (jsonb_typeof(decision_evidence) = 'object'),
  qualifiers BIGINT CHECK (qualifiers >= 0),
  global_weight NUMERIC CHECK (global_weight >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(network,deployment_fingerprint,vault_id,ordinal),
  FOREIGN KEY(network,deployment_fingerprint,vault_id) REFERENCES presale_daily_vaults
);
CREATE FUNCTION presale_daily_period_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
CREATE TRIGGER presale_daily_vault_identity BEFORE UPDATE ON presale_daily_vaults FOR EACH ROW EXECUTE FUNCTION presale_daily_period_immutable();
CREATE TRIGGER presale_daily_period_identity BEFORE UPDATE ON presale_daily_periods FOR EACH ROW EXECUTE FUNCTION presale_daily_period_immutable();

CREATE TABLE presale_daily_plans (
  plan_id UUID PRIMARY KEY,
  period_id UUID NOT NULL UNIQUE REFERENCES presale_daily_periods,
  round_number NUMERIC(20,0) NOT NULL CHECK (round_number BETWEEN 0 AND 18446744073709551615),
  budget_generation BIGINT NOT NULL,
  gross NUMERIC(20,0) NOT NULL CHECK (gross BETWEEN 0 AND 18446744073709551615),
  reserve NUMERIC(20,0) NOT NULL CHECK (reserve BETWEEN 0 AND floor(gross / 20)),
  holder NUMERIC(20,0) NOT NULL CHECK (holder = gross - reserve),
  allocated NUMERIC(20,0) CHECK (allocated BETWEEN 0 AND holder),
  dust NUMERIC(20,0) CHECK (dust = holder - allocated),
  positive_leaves BIGINT CHECK (positive_leaves BETWEEN 0 AND 65536),
  inputs JSONB NOT NULL CHECK (jsonb_typeof(inputs) = 'object'),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  stage TEXT NOT NULL DEFAULT 'allocations' CHECK (stage IN ('allocations','hashes','proofs','uploaded','ready','funded','cancelled')),
  allocation_cursor TEXT,
  allocated_weight NUMERIC NOT NULL DEFAULT 0 CHECK (allocated_weight >= 0),
  manifest JSONB CHECK (jsonb_typeof(manifest) = 'object'),
  storage_url TEXT,
  storage_hash TEXT CHECK (storage_hash ~ '^[0-9a-f]{64}$'),
  storage_verified_at TIMESTAMPTZ,
  CHECK (stage NOT IN ('ready','funded') OR
    (allocated IS NOT NULL AND dust IS NOT NULL AND positive_leaves > 0 AND manifest IS NOT NULL
      AND storage_url IS NOT NULL AND storage_hash IS NOT NULL AND storage_verified_at IS NOT NULL))
);
CREATE TABLE presale_daily_allocations (
  plan_id UUID NOT NULL REFERENCES presale_daily_plans,
  leaf_index BIGINT NOT NULL CHECK (leaf_index BETWEEN 0 AND 65535),
  beneficiary TEXT NOT NULL CHECK (beneficiary ~ '^0x[0-9a-f]{64}$'),
  weight NUMERIC NOT NULL CHECK (weight > 0),
  quote_amount NUMERIC(20,0) NOT NULL CHECK (quote_amount BETWEEN 1 AND 18446744073709551615),
  proof JSONB CHECK (jsonb_typeof(proof) = 'array'),
  PRIMARY KEY(plan_id,leaf_index),
  UNIQUE(plan_id,beneficiary)
);
CREATE TABLE presale_daily_hashes (
  plan_id UUID NOT NULL REFERENCES presale_daily_plans,
  level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 16),
  node_index BIGINT NOT NULL CHECK (node_index BETWEEN 0 AND 65535),
  hash BYTEA NOT NULL CHECK (octet_length(hash) = 32),
  PRIMARY KEY(plan_id,level,node_index)
);
CREATE TABLE presale_quote_reservations (
  plan_id UUID PRIMARY KEY REFERENCES presale_daily_plans,
  amount NUMERIC(20,0) NOT NULL CHECK (amount BETWEEN 1 AND 18446744073709551615),
  source_evidence JSONB NOT NULL CHECK (jsonb_typeof(source_evidence) = 'object'),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','funded','released')),
  funded_checkpoint BIGINT CHECK (funded_checkpoint >= 0),
  funded_digest TEXT,
  CHECK ((state = 'funded') = (funded_checkpoint IS NOT NULL AND funded_digest IS NOT NULL))
);
CREATE INDEX presale_daily_period_work ON presale_daily_periods(status,created_at)
  WHERE status IN ('waiting_price','blocked','staging','ready');
CREATE INDEX presale_quote_reservations_live ON presale_quote_reservations(state) WHERE state <> 'released';

CREATE FUNCTION presale_daily_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
CREATE TRIGGER presale_daily_plan_immutable BEFORE UPDATE ON presale_daily_plans FOR EACH ROW EXECUTE FUNCTION presale_daily_immutable();
CREATE TRIGGER presale_quote_reservation_immutable BEFORE UPDATE ON presale_quote_reservations FOR EACH ROW EXECUTE FUNCTION presale_daily_immutable();
CREATE TRIGGER presale_daily_allocation_immutable BEFORE UPDATE ON presale_daily_allocations FOR EACH ROW EXECUTE FUNCTION presale_daily_immutable();
CREATE TRIGGER presale_daily_hash_immutable BEFORE UPDATE ON presale_daily_hashes FOR EACH ROW EXECUTE FUNCTION presale_daily_immutable();

ALTER TABLE presale_daily_vaults OWNER TO blast_indexer;
ALTER TABLE presale_daily_periods OWNER TO blast_indexer;
ALTER TABLE presale_daily_plans OWNER TO blast_indexer;
ALTER TABLE presale_daily_allocations OWNER TO blast_indexer;
ALTER TABLE presale_daily_hashes OWNER TO blast_indexer;
ALTER TABLE presale_quote_reservations OWNER TO blast_indexer;
REVOKE ALL ON presale_daily_vaults,presale_daily_periods,presale_daily_plans,presale_daily_allocations,
  presale_daily_hashes,presale_quote_reservations FROM PUBLIC,blast_web,blast_watcher,blast_social,blast_replica;
GRANT SELECT ON presale_daily_vaults,presale_daily_periods,presale_daily_plans,presale_daily_allocations,
  presale_daily_hashes,presale_quote_reservations TO blast_watcher;
REVOKE ALL ON FUNCTION presale_daily_immutable(),presale_daily_period_immutable() FROM PUBLIC;
-- Publication readiness and the exclusive monetary reservation share the primary commit.
GRANT SELECT,INSERT ON presale_outbox_actions TO blast_indexer;

CREATE TABLE presale_daily_executions (
  plan_id UUID PRIMARY KEY REFERENCES presale_daily_plans,
  round_id TEXT NOT NULL UNIQUE CHECK(round_id ~ '^0x[0-9a-f]{64}$'),
  publish_digest TEXT NOT NULL CHECK(publish_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  publication_checkpoint BIGINT NOT NULL CHECK(publication_checkpoint >= 0),
  claim_deadline_ms NUMERIC(20,0) NOT NULL CHECK(claim_deadline_ms BETWEEN 0 AND 18446744073709551615),
  treasury TEXT NOT NULL CHECK(treasury ~ '^0x[0-9a-f]{64}$'),
  meme_type TEXT NOT NULL,
  quote_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX presale_daily_settlement_work ON presale_daily_executions(created_at,plan_id);
CREATE TABLE presale_daily_deliveries (
  plan_id UUID NOT NULL,
  leaf_index BIGINT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','blocked','paid','closed')),
  reason TEXT,
  digest TEXT CHECK(digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  checkpoint BIGINT CHECK(checkpoint >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(plan_id,leaf_index),
  FOREIGN KEY(plan_id,leaf_index) REFERENCES presale_daily_allocations,
  CHECK(state NOT IN ('paid','closed') OR (digest IS NOT NULL AND checkpoint IS NOT NULL))
);
CREATE TABLE presale_daily_gas_effects (
  digest TEXT PRIMARY KEY REFERENCES presale_outbox_attempts,
  plan_id UUID NOT NULL REFERENCES presale_daily_plans,
  action_id UUID NOT NULL REFERENCES presale_outbox_actions,
  kind TEXT NOT NULL CHECK(kind IN ('publish_reward','claim_reward')),
  checkpoint BIGINT NOT NULL CHECK(checkpoint >= 0),
  execution_timestamp_ms BIGINT NOT NULL CHECK(execution_timestamp_ms >= 0),
  computation_cost NUMERIC(20,0) NOT NULL CHECK(computation_cost BETWEEN 0 AND 18446744073709551615),
  storage_cost NUMERIC(20,0) NOT NULL CHECK(storage_cost BETWEEN 0 AND 18446744073709551615),
  storage_rebate NUMERIC(20,0) NOT NULL CHECK(storage_rebate BETWEEN 0 AND 18446744073709551615),
  non_refundable_storage_fee NUMERIC(20,0) NOT NULL CHECK(non_refundable_storage_fee BETWEEN 0 AND 18446744073709551615),
  net_sui_atoms NUMERIC NOT NULL CHECK(net_sui_atoms=computation_cost+storage_cost-storage_rebate),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE presale_daily_gas_prices (
  digest TEXT PRIMARY KEY REFERENCES presale_daily_gas_effects,
  sui_usd JSONB NOT NULL CHECK(jsonb_typeof(sui_usd)='object'),
  quote_usd JSONB NOT NULL CHECK(jsonb_typeof(quote_usd)='object'),
  evidence JSONB NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  pricing_cut JSONB NOT NULL CHECK(jsonb_typeof(pricing_cut)='object')
);
CREATE TABLE presale_daily_round_status (
  plan_id UUID PRIMARY KEY REFERENCES presale_daily_executions,
  state TEXT NOT NULL CHECK(state IN ('open','settled','closed')),
  settlement_digest TEXT CHECK(settlement_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  close_digest TEXT CHECK(close_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  checkpoint BIGINT NOT NULL CHECK(checkpoint >= 0),
  CHECK(state <> 'settled' OR settlement_digest IS NOT NULL),
  CHECK((state='closed')=(close_digest IS NOT NULL))
);
CREATE FUNCTION presale_daily_execution_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'finalized daily execution evidence is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION presale_daily_terminal_evidence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='presale_daily_deliveries' THEN
    IF NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.leaf_index IS DISTINCT FROM OLD.leaf_index
       OR (OLD.state IN ('paid','closed') AND (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at')) THEN
      RAISE EXCEPTION 'terminal delivery evidence is immutable';
    END IF;
  ELSE
    IF NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.checkpoint<OLD.checkpoint
       OR (OLD.state='settled' AND NEW.state='open')
       OR (OLD.state='closed' AND NEW IS DISTINCT FROM OLD)
       OR (OLD.settlement_digest IS NOT NULL AND NEW.settlement_digest IS DISTINCT FROM OLD.settlement_digest)
       OR (OLD.close_digest IS NOT NULL AND NEW.close_digest IS DISTINCT FROM OLD.close_digest) THEN
      RAISE EXCEPTION 'terminal round evidence is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER presale_daily_delivery_terminal BEFORE UPDATE ON presale_daily_deliveries FOR EACH ROW EXECUTE FUNCTION presale_daily_terminal_evidence();
CREATE TRIGGER presale_daily_round_terminal BEFORE UPDATE ON presale_daily_round_status FOR EACH ROW EXECUTE FUNCTION presale_daily_terminal_evidence();
CREATE INDEX presale_daily_gas_plan_digest ON presale_daily_gas_effects(plan_id,digest COLLATE "C");
CREATE TRIGGER presale_daily_execution_immutable BEFORE UPDATE ON presale_daily_executions FOR EACH ROW EXECUTE FUNCTION presale_daily_execution_immutable();
CREATE TRIGGER presale_daily_gas_effect_immutable BEFORE UPDATE ON presale_daily_gas_effects FOR EACH ROW EXECUTE FUNCTION presale_daily_execution_immutable();
CREATE TRIGGER presale_daily_gas_price_immutable BEFORE UPDATE ON presale_daily_gas_prices FOR EACH ROW EXECUTE FUNCTION presale_daily_execution_immutable();
ALTER TABLE presale_daily_executions OWNER TO blast_indexer;
ALTER TABLE presale_daily_gas_prices OWNER TO blast_indexer;
REVOKE ALL ON presale_daily_executions,presale_daily_deliveries,presale_daily_gas_effects,presale_daily_gas_prices,
  presale_daily_round_status FROM PUBLIC,blast_web,blast_watcher,blast_social,blast_replica;
GRANT SELECT ON presale_daily_executions,presale_daily_gas_prices TO blast_watcher;
GRANT SELECT,INSERT,UPDATE ON presale_daily_deliveries,presale_daily_round_status TO blast_watcher;
GRANT SELECT,INSERT ON presale_daily_gas_effects TO blast_watcher;
GRANT SELECT,INSERT ON presale_daily_deliveries,presale_daily_round_status TO blast_indexer;
GRANT SELECT ON presale_daily_gas_effects TO blast_indexer;
REVOKE ALL ON FUNCTION presale_daily_execution_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION presale_daily_terminal_evidence() FROM PUBLIC;

CREATE FUNCTION presale_published_daily_manifest(target_round TEXT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE result TEXT;
BEGIN
  IF target_round IS NULL OR target_round !~ '^0x[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  SELECT p.storage_url INTO result FROM presale_daily_executions x
  JOIN presale_daily_plans p USING(plan_id)
  JOIN chain_read_v1.presale_reward_rounds r ON r.round_id=x.round_id
  WHERE x.round_id=target_round AND p.stage='funded' AND p.storage_verified_at IS NOT NULL
    AND r.vault_id=p.manifest->>'vaultId' AND r.number::text=p.manifest->>'number'
    AND r.start_checkpoint::text=p.manifest->>'startCheckpoint'
    AND r.end_checkpoint::text=p.manifest->>'endCheckpoint'
    AND r.root=p.manifest->>'root' AND r.manifest_digest=p.manifest->>'manifestDigest'
    AND r.leaf_count::text=p.manifest->>'leafCount'
    AND r.meme_amount::text='0' AND r.quote_amount=p.allocated
    AND r.gas_reserve_amount=p.reserve AND r.treasury=x.treasury
    AND r.published_tx_digest=x.publish_digest AND r.published_checkpoint=x.publication_checkpoint;
  RETURN result;
END $$;
ALTER FUNCTION presale_published_daily_manifest(TEXT) OWNER TO blast_indexer;
REVOKE ALL ON FUNCTION presale_published_daily_manifest(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION presale_published_daily_manifest(TEXT) TO blast_web,blast_replica;

-- The planner sees custody barriers without receiving transaction bytes or signatures.
CREATE FUNCTION presale_daily_gas_work_pending(target_plan UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
BEGIN
  RETURN EXISTS(SELECT 1 FROM presale_outbox_actions a JOIN presale_daily_periods d
    ON a.network=d.network AND a.deployment_fingerprint=d.deployment_fingerprint
    JOIN presale_daily_plans p USING(period_id) WHERE p.plan_id=target_plan
    AND a.role='presale-rewards' AND a.kind IN ('publish_reward','claim_reward')
    AND (a.payload->>'planId'=target_plan::text OR a.payload->'intent'->>'planId'=target_plan::text)
    AND (a.state NOT IN ('confirmed','superseded') OR EXISTS(
      SELECT 1 FROM presale_outbox_prepared_inputs b WHERE b.action_id=a.action_id AND b.resolved_at IS NULL)))
    OR EXISTS(SELECT 1 FROM presale_outbox_attempts t JOIN presale_outbox_actions a USING(action_id)
      JOIN presale_daily_periods d ON a.network=d.network AND a.deployment_fingerprint=d.deployment_fingerprint
      JOIN presale_daily_plans p USING(period_id) WHERE p.plan_id=target_plan AND a.role='presale-rewards'
      AND a.kind IN ('publish_reward','claim_reward') AND t.execution_intent->>'planId'=target_plan::text
      AND (t.resolved_at IS NULL OR (t.resolution IN ('executed','failed')
        AND NOT EXISTS(SELECT 1 FROM presale_daily_gas_effects g WHERE g.digest=t.digest AND g.plan_id=target_plan AND g.action_id=a.action_id))));
END $$;
ALTER FUNCTION presale_daily_gas_work_pending(UUID) OWNER TO blast_watcher;
REVOKE ALL ON FUNCTION presale_daily_gas_work_pending(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION presale_daily_gas_work_pending(UUID) TO blast_indexer;

CREATE INDEX presale_daily_refresh_work ON presale_outbox_actions(network,deployment_fingerprint,due_at,action_id)
  WHERE kind='publish_reward' AND state IN ('ready','retry_wait','claimed');

-- Only an expired, provably unsigned deadline can change; source money and proofs stay fixed.
CREATE FUNCTION presale_refresh_unsigned_publication(old_id UUID,new_id UUID,payload_text TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE old presale_outbox_actions; plan presale_daily_plans; period presale_daily_periods;
  coverage RECORD; funding JSONB; body JSONB:=payload_text::jsonb; held NUMERIC;
BEGIN
  SELECT * INTO old FROM presale_outbox_actions WHERE action_id=old_id FOR UPDATE;
  IF old.action_id IS NULL OR old.kind<>'publish_reward' OR old.role<>'presale-rewards'
    OR old.state NOT IN ('ready','retry_wait','claimed') OR (old.owner IS NOT NULL AND old.lease_until>now())
    OR EXISTS(SELECT FROM presale_outbox_attempts WHERE action_id=old_id AND resolved_at IS NULL)
    OR EXISTS(SELECT FROM presale_outbox_prepared_inputs WHERE action_id=old_id AND resolved_at IS NULL)
    OR body-'publication' IS DISTINCT FROM old.payload-'publication' THEN RAISE EXCEPTION 'publication is signed, active or changed'; END IF;
  SELECT * INTO plan FROM presale_daily_plans WHERE plan_id=(old.payload->>'planId')::uuid;
  SELECT * INTO period FROM presale_daily_periods WHERE period_id=plan.period_id;
  IF plan.stage<>'ready' OR period.network<>old.network OR period.deployment_fingerprint<>old.deployment_fingerprint
    OR period.vault_id<>old.entity OR NOT EXISTS(SELECT FROM presale_quote_reservations WHERE plan_id=plan.plan_id AND state='reserved')
    THEN RAISE EXCEPTION 'publication reservation is unavailable'; END IF;
  SELECT * INTO coverage FROM chain_read_v1.projection_coverage WHERE network=old.network
    AND deployment_fingerprint=plan.inputs->>'indexedDeploymentFingerprint' AND pipeline='presale' AND fault_checkpoint IS NULL;
  IF coverage.checkpoint IS NULL OR coverage.timestamp_ms<(old.payload->'publication'->>'claimDeadlineMs')::numeric
    OR body->'publication' IS DISTINCT FROM jsonb_build_object('preparedAtMs',coverage.timestamp_ms::text,
      'claimDeadlineMs',(coverage.timestamp_ms::numeric+604800000)::text) THEN RAISE EXCEPTION 'publication deadline is not an expired native cut'; END IF;
  PERFORM chain_read_v1.require_cut(old.network,plan.inputs->>'indexedDeploymentFingerprint',coverage.checkpoint,coverage.checkpoint_digest,ARRAY['presale','intake']);
  IF NOT EXISTS(SELECT FROM chain_read_v1.reward_vault_planning WHERE vault_id=period.vault_id AND next_round=plan.round_number)
    THEN RAISE EXCEPTION 'native publication number changed'; END IF;
  funding:=chain_read_v1.holder_quote(old.network,plan.inputs->>'indexedDeploymentFingerprint',period.vault_id,
    coverage.checkpoint,coverage.checkpoint_digest,4294967295,4294967295);
  SELECT coalesce(sum(r.amount),0) INTO held FROM presale_quote_reservations r JOIN presale_daily_plans p USING(plan_id)
    JOIN presale_daily_periods d USING(period_id) WHERE d.network=old.network AND d.vault_id=period.vault_id AND r.state='reserved';
  IF funding->>'available' IS DISTINCT FROM 'true' OR funding->>'quote_available' IS NULL
    OR (funding->>'quote_available')::numeric<held THEN RAISE EXCEPTION 'publication custody is unavailable'; END IF;
  UPDATE presale_outbox_actions SET state='superseded',reason='unsigned-deadline-expired',owner=NULL,lease_until=NULL,
    generation=generation+1,updated_at=now() WHERE action_id=old_id;
  INSERT INTO presale_outbox_actions(action_id,semantic_key,network,deployment_fingerprint,role,kind,entity,payload,payload_hash)
    VALUES(new_id,old.semantic_key||':after:'||old_id::text,old.network,old.deployment_fingerprint,old.role,old.kind,old.entity,
      body,encode(sha256(convert_to(payload_text,'UTF8')),'hex'));
END $$;
ALTER FUNCTION presale_refresh_unsigned_publication(UUID,UUID,TEXT) OWNER TO blast_watcher;
REVOKE ALL ON FUNCTION presale_refresh_unsigned_publication(UUID,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION presale_refresh_unsigned_publication(UUID,UUID,TEXT) TO blast_indexer;


-- A wallet-scoped public reader exposes unpaid funded entitlements without granting raw financial tables.
CREATE FUNCTION presale_daily_waiting_rewards(expected_network TEXT,expected_fp TEXT,wallets TEXT[])
RETURNS TABLE(presale_id TEXT,meme_type TEXT,quote_type TEXT,round_id TEXT,number TEXT,leaf_index BIGINT,
  beneficiary TEXT,meme_amount TEXT,quote_amount TEXT,reason TEXT,decided_at TIMESTAMPTZ,claim_deadline_ms TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE head RECORD;
BEGIN
  IF expected_network IS NULL OR expected_fp IS NULL OR expected_fp !~ '^[0-9a-f]{64}$'
    OR wallets IS NULL OR cardinality(wallets) NOT BETWEEN 1 AND 50
    OR EXISTS(SELECT FROM unnest(wallets) w WHERE w IS NULL OR w !~ '^0x[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'invalid daily waiting reward scope';
  END IF;
  SELECT c.checkpoint,c.checkpoint_digest INTO head FROM chain_read_v1.projection_coverage c
    WHERE c.network=expected_network AND c.deployment_fingerprint=expected_fp AND c.pipeline='presale' AND c.fault_checkpoint IS NULL;
  IF head.checkpoint IS NULL THEN RAISE EXCEPTION 'native daily waiting reward coverage unavailable'; END IF;
  PERFORM chain_read_v1.require_cut(expected_network,expected_fp,head.checkpoint,head.checkpoint_digest,ARRAY['presale']);
  RETURN QUERY
    SELECT r.presale_id,x.meme_type,x.quote_type,x.round_id,p.round_number::text,a.leaf_index,a.beneficiary,
      '0'::text,a.quote_amount::text,CASE WHEN d.state='blocked' THEN 'unpayable' ELSE 'next' END,
      coalesce(d.updated_at,x.created_at),x.claim_deadline_ms::text
    FROM presale_daily_executions x JOIN presale_daily_plans p USING(plan_id)
    JOIN presale_daily_periods period USING(period_id) JOIN presale_daily_allocations a USING(plan_id)
    LEFT JOIN presale_daily_deliveries d USING(plan_id,leaf_index)
    JOIN chain_read_v1.presale_reward_rounds r ON r.round_id=x.round_id
    WHERE period.network=expected_network AND p.inputs->>'indexedDeploymentFingerprint'=expected_fp AND p.stage='funded'
      AND a.beneficiary=ANY(wallets) AND a.quote_amount>0 AND coalesce(d.state,'pending') NOT IN ('paid','closed')
      AND r.vault_id=period.vault_id AND r.number=p.round_number AND r.sale_token=x.meme_type AND r.quote_type=x.quote_type
      AND r.claim_deadline_ms=x.claim_deadline_ms AND r.gas_reserve_amount=p.reserve AND r.treasury=x.treasury
      AND r.root=p.manifest->>'root' AND r.manifest_digest=p.manifest->>'manifestDigest' AND r.leaf_count=p.positive_leaves
      AND r.quote_amount=p.allocated AND r.meme_amount=0 AND r.published_tx_digest=x.publish_digest
      AND r.published_checkpoint=x.publication_checkpoint AND r.published_checkpoint<=head.checkpoint AND r.applied_checkpoint<=head.checkpoint
      AND NOT r.closed AND NOT EXISTS(SELECT FROM chain_read_v1.presale_reward_payouts paid
        WHERE paid.round_id=x.round_id AND paid.index=a.leaf_index AND paid.beneficiary=a.beneficiary
          AND paid.meme_amount=0 AND paid.quote_amount=a.quote_amount AND paid.checkpoint<=head.checkpoint)
    ORDER BY x.publication_checkpoint,x.round_id,a.leaf_index;
END $$;
ALTER FUNCTION presale_daily_waiting_rewards(TEXT,TEXT,TEXT[]) OWNER TO blast_indexer;
REVOKE ALL ON FUNCTION presale_daily_waiting_rewards(TEXT,TEXT,TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION presale_daily_waiting_rewards(TEXT,TEXT,TEXT[]) TO blast_web;
