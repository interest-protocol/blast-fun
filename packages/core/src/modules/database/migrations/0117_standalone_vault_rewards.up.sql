CREATE FUNCTION vault_daily_waiting_rewards(expected_network TEXT,expected_fp TEXT,wallets TEXT[])
RETURNS TABLE(presale_id TEXT,vault_id TEXT,meme_type TEXT,quote_type TEXT,round_id TEXT,number TEXT,leaf_index BIGINT,
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
    SELECT r.presale_id,r.vault_id,x.meme_type,x.quote_type,x.round_id,p.round_number::text,a.leaf_index,a.beneficiary,
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
ALTER FUNCTION vault_daily_waiting_rewards(TEXT,TEXT,TEXT[]) OWNER TO blast_indexer;
REVOKE ALL ON FUNCTION vault_daily_waiting_rewards(TEXT,TEXT,TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault_daily_waiting_rewards(TEXT,TEXT,TEXT[]) TO blast_web;
