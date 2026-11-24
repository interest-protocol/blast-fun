-- Contracts #167: a holder-reward round is scheduled (RewardsAdmin), waits the vault's round notice
-- and is then published by anyone. Each reserved plan commits both steps; the claim window is a
-- duration that publication starts, so an unsigned commitment no longer expires.
ALTER TABLE presale_outbox_actions DROP CONSTRAINT presale_outbox_actions_kind_check;
ALTER TABLE presale_outbox_actions ADD CONSTRAINT presale_outbox_actions_kind_check
 CHECK(kind IN ('settle','settle_migrate','migrate','partner_payout','collect_fees','schedule_reward','publish_reward',
  'claim_reward','settle_reward_gas','close_reward'));
ALTER TABLE presale_outbox_actions DROP CONSTRAINT presale_outbox_actions_launch_kinds;
ALTER TABLE presale_outbox_actions ADD CONSTRAINT presale_outbox_actions_launch_kinds
 CHECK(role<>'launchpad-rewards' OR kind IN ('collect_fees','schedule_reward','publish_reward','claim_reward','settle_reward_gas','close_reward'));
-- The schedule's gas is an eligible cost like publication and delivery.
ALTER TABLE presale_daily_gas_effects DROP CONSTRAINT presale_daily_gas_effects_kind_check;
ALTER TABLE presale_daily_gas_effects ADD CONSTRAINT presale_daily_gas_effects_kind_check
 CHECK(kind IN ('schedule_reward','publish_reward','claim_reward'));
CREATE OR REPLACE FUNCTION presale_daily_gas_work_pending(target_plan UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
BEGIN
  RETURN EXISTS(SELECT 1 FROM presale_outbox_actions a JOIN presale_daily_periods d
    ON a.network=d.network AND a.deployment_fingerprint=d.deployment_fingerprint
    JOIN presale_daily_plans p USING(period_id) WHERE p.plan_id=target_plan
    AND a.role IN ('presale-rewards','launchpad-rewards') AND a.kind IN ('schedule_reward','publish_reward','claim_reward')
    AND (a.payload->>'planId'=target_plan::text OR a.payload->'intent'->>'planId'=target_plan::text)
    AND (a.state NOT IN ('confirmed','superseded') OR EXISTS(
      SELECT 1 FROM presale_outbox_prepared_inputs b WHERE b.action_id=a.action_id AND b.resolved_at IS NULL)))
    OR EXISTS(SELECT 1 FROM presale_outbox_attempts t JOIN presale_outbox_actions a USING(action_id)
      JOIN presale_daily_periods d ON a.network=d.network AND a.deployment_fingerprint=d.deployment_fingerprint
      JOIN presale_daily_plans p USING(period_id) WHERE p.plan_id=target_plan AND a.role IN ('presale-rewards','launchpad-rewards')
      AND a.kind IN ('schedule_reward','publish_reward','claim_reward') AND t.execution_intent->>'planId'=target_plan::text
      AND (t.resolved_at IS NULL OR (t.resolution IN ('executed','failed')
        AND NOT EXISTS(SELECT 1 FROM presale_daily_gas_effects g WHERE g.digest=t.digest AND g.plan_id=target_plan AND g.action_id=a.action_id))));
END $$;
-- Absolute publication deadlines are gone, and with them the unsigned-deadline refresh.
DROP FUNCTION presale_refresh_unsigned_publication(UUID,UUID,TEXT);
DROP INDEX presale_daily_refresh_work;
CREATE INDEX presale_daily_waiting_publication ON presale_outbox_actions(network,deployment_fingerprint,role)
  WHERE kind='publish_reward' AND state='waiting';
