-- PR150 is a new worker scope. Historical signed intents and execution rows remain immutable.
CREATE OR REPLACE FUNCTION presale_daily_execution_kind() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.claim_deadline_ms IS NULL OR NEW.treasury IS NULL THEN
  RAISE EXCEPTION 'new reward executions require a deadline and snapshotted treasury';
 END IF;
 RETURN NEW;
END $$;
ALTER TABLE presale_outbox_actions DROP CONSTRAINT presale_outbox_actions_launch_kinds;
ALTER TABLE presale_outbox_actions ADD CONSTRAINT presale_outbox_actions_launch_kinds
 CHECK(role<>'launchpad-rewards' OR kind IN ('collect_fees','publish_reward','claim_reward','settle_reward_gas','close_reward'));
CREATE OR REPLACE FUNCTION presale_daily_gas_work_pending(target_plan UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
BEGIN
  RETURN EXISTS(SELECT 1 FROM presale_outbox_actions a JOIN presale_daily_periods d
    ON a.network=d.network AND a.deployment_fingerprint=d.deployment_fingerprint
    JOIN presale_daily_plans p USING(period_id) WHERE p.plan_id=target_plan
    AND a.role IN ('presale-rewards','launchpad-rewards') AND a.kind IN ('publish_reward','claim_reward')
    AND (a.payload->>'planId'=target_plan::text OR a.payload->'intent'->>'planId'=target_plan::text)
    AND (a.state NOT IN ('confirmed','superseded') OR EXISTS(
      SELECT 1 FROM presale_outbox_prepared_inputs b WHERE b.action_id=a.action_id AND b.resolved_at IS NULL)))
    OR EXISTS(SELECT 1 FROM presale_outbox_attempts t JOIN presale_outbox_actions a USING(action_id)
      JOIN presale_daily_periods d ON a.network=d.network AND a.deployment_fingerprint=d.deployment_fingerprint
      JOIN presale_daily_plans p USING(period_id) WHERE p.plan_id=target_plan AND a.role IN ('presale-rewards','launchpad-rewards')
      AND a.kind IN ('publish_reward','claim_reward') AND t.execution_intent->>'planId'=target_plan::text
      AND (t.resolved_at IS NULL OR (t.resolution IN ('executed','failed')
        AND NOT EXISTS(SELECT 1 FROM presale_daily_gas_effects g WHERE g.digest=t.digest AND g.plan_id=target_plan AND g.action_id=a.action_id))));
END $$;
CREATE OR REPLACE FUNCTION presale_refresh_unsigned_publication(old_id UUID,new_id UUID,payload_text TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE old presale_outbox_actions; plan presale_daily_plans; period presale_daily_periods;
  vault_kind TEXT; coverage RECORD; funding JSONB; body JSONB:=payload_text::jsonb; held NUMERIC;
BEGIN
  SELECT * INTO old FROM presale_outbox_actions WHERE action_id=old_id FOR UPDATE;
  IF old.action_id IS NULL OR old.kind<>'publish_reward' OR old.role NOT IN ('presale-rewards','launchpad-rewards')
    OR old.state NOT IN ('ready','retry_wait','claimed') OR (old.owner IS NOT NULL AND old.lease_until>now())
    OR EXISTS(SELECT FROM presale_outbox_attempts WHERE action_id=old_id AND resolved_at IS NULL)
    OR EXISTS(SELECT FROM presale_outbox_prepared_inputs WHERE action_id=old_id AND resolved_at IS NULL)
    OR body-'publication' IS DISTINCT FROM old.payload-'publication' THEN RAISE EXCEPTION 'publication is signed, active or changed'; END IF;
  SELECT * INTO plan FROM presale_daily_plans WHERE plan_id=(old.payload->>'planId')::uuid;
  SELECT * INTO period FROM presale_daily_periods WHERE period_id=plan.period_id;
  IF plan.stage<>'ready' OR period.network<>old.network OR period.deployment_fingerprint<>old.deployment_fingerprint
    OR period.vault_id<>old.entity OR NOT EXISTS(SELECT FROM presale_quote_reservations WHERE plan_id=plan.plan_id AND state='reserved')
    THEN RAISE EXCEPTION 'publication reservation is unavailable'; END IF;
  SELECT v.vault_kind INTO vault_kind FROM presale_daily_vaults v WHERE v.network=period.network AND v.deployment_fingerprint=period.deployment_fingerprint AND v.vault_id=period.vault_id;
  IF old.role IS DISTINCT FROM (CASE WHEN vault_kind='launch' THEN 'launchpad-rewards' ELSE 'presale-rewards' END) THEN RAISE EXCEPTION 'publication role differs from vault kind'; END IF;
  SELECT * INTO coverage FROM chain_read_v1.projection_coverage WHERE network=old.network
    AND deployment_fingerprint=plan.inputs->>'indexedDeploymentFingerprint' AND pipeline=CASE WHEN vault_kind='launch' THEN 'market' ELSE 'presale' END AND fault_checkpoint IS NULL;
  IF coverage.checkpoint IS NULL OR coverage.timestamp_ms<(old.payload->'publication'->>'claimDeadlineMs')::numeric
    OR body->'publication' IS DISTINCT FROM jsonb_build_object('preparedAtMs',coverage.timestamp_ms::text,
      'claimDeadlineMs',(coverage.timestamp_ms::numeric+604800000)::text) THEN RAISE EXCEPTION 'publication deadline is not an expired native cut'; END IF;
  PERFORM chain_read_v1.require_cut(old.network,plan.inputs->>'indexedDeploymentFingerprint',coverage.checkpoint,coverage.checkpoint_digest,CASE WHEN vault_kind='launch' THEN ARRAY['market','intake'] ELSE ARRAY['presale','intake'] END);
  IF vault_kind='launch' THEN
    IF NOT EXISTS(SELECT FROM chain_read_v1.launch_reward_vault_planning WHERE vault_id=period.vault_id AND next_round=plan.round_number) THEN RAISE EXCEPTION 'native publication number changed'; END IF;
    funding:=chain_read_v1.launch_reward_funds(old.network,plan.inputs->>'indexedDeploymentFingerprint',period.vault_id,coverage.checkpoint,coverage.checkpoint_digest,4294967295,4294967295);
  ELSE
  IF NOT EXISTS(SELECT FROM chain_read_v1.reward_vault_planning WHERE vault_id=period.vault_id AND next_round=plan.round_number)
    THEN RAISE EXCEPTION 'native publication number changed'; END IF;
  funding:=chain_read_v1.holder_quote(old.network,plan.inputs->>'indexedDeploymentFingerprint',period.vault_id,
    coverage.checkpoint,coverage.checkpoint_digest,4294967295,4294967295);
  END IF;
  SELECT coalesce(sum(r.amount),0) INTO held FROM presale_quote_reservations r JOIN presale_daily_plans p USING(plan_id)
    JOIN presale_daily_periods d USING(period_id) WHERE d.network=old.network AND d.vault_id=period.vault_id AND r.state='reserved';
  IF funding->>'available' IS DISTINCT FROM 'true' OR funding->>'quote_available' IS NULL
    OR (funding->>'quote_available')::numeric<held THEN RAISE EXCEPTION 'publication custody is unavailable'; END IF;
  IF vault_kind='launch' AND coalesce((funding->>'meme_available')::numeric,-1) < (SELECT coalesce(sum(r.meme_amount),0) FROM presale_quote_reservations r JOIN presale_daily_plans p USING(plan_id) JOIN presale_daily_periods d USING(period_id) WHERE d.network=old.network AND d.vault_id=period.vault_id AND r.state='reserved') THEN RAISE EXCEPTION 'publication meme custody is unavailable'; END IF;
  UPDATE presale_outbox_actions SET state='superseded',reason='unsigned-deadline-expired',owner=NULL,lease_until=NULL,
    generation=generation+1,updated_at=now() WHERE action_id=old_id;
  INSERT INTO presale_outbox_actions(action_id,semantic_key,network,deployment_fingerprint,role,kind,entity,payload,payload_hash)
    VALUES(new_id,old.semantic_key||':after:'||old_id::text,old.network,old.deployment_fingerprint,old.role,old.kind,old.entity,
      body,encode(sha256(convert_to(payload_text,'UTF8')),'hex'));
END $$;
