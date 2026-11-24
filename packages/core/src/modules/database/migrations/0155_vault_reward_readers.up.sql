-- Resolve published rewards from the canonical indexer and the unified journal.
-- PL/pgSQL binds the reader views at call time, so migrations can precede replay.
CREATE FUNCTION vault_reward_publications(
  expected_network TEXT, expected_fp TEXT, target_round TEXT, wallets TEXT[]
) RETURNS TABLE(plan_id UUID, vault_id TEXT, origin_kind TEXT, origin_id TEXT,
  meme_type TEXT, quote_type TEXT, round_id TEXT, number TEXT, published_checkpoint BIGINT,
  claim_deadline_ms TEXT, published_at TIMESTAMPTZ, closed BOOLEAN, storage_url TEXT)
LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $$
BEGIN
  RETURN QUERY
    SELECT p.plan_id, v.vault_id, v.origin_kind, v.origin_id, v.meme_type, v.quote_type,
      r.round_id, r.number::text, r.published_checkpoint, r.claim_deadline_at_ms::text,
      to_timestamp(r.published_timestamp_ms / 1000.0), r.closed, p.storage_url
    FROM vault_reward_periods d
    JOIN vault_reward_plans p ON p.period_id=d.period_id
    JOIN chain_read_v1.vault_rounds r ON r.vault_id=d.vault_id AND r.number=p.number
    JOIN chain_read_v1.vaults v ON v.vault_id=r.vault_id
    WHERE d.network=expected_network AND d.deployment_fingerprint=expected_fp
      AND (target_round IS NULL OR r.round_id=target_round)
      AND (wallets IS NULL OR EXISTS (
        SELECT FROM vault_reward_allocations a
        WHERE a.plan_id=p.plan_id AND a.beneficiary=ANY(wallets)
      ))
      AND p.stage IN ('published','closed') AND p.storage_verified_at IS NOT NULL
      AND p.storage_url IS NOT NULL AND p.storage_hash IS NOT NULL
      AND r.vault_id=p.manifest->>'vaultId' AND r.number::text=p.manifest->>'number'
      AND r.start_checkpoint::text=p.manifest->>'startCheckpoint'
      AND r.end_checkpoint::text=p.manifest->>'endCheckpoint'
      AND r.root=p.manifest->>'root' AND r.manifest_digest=p.manifest->>'manifestDigest'
      AND r.leaf_count::text=p.manifest->>'leafCount'
      AND r.meme_amount::text=p.manifest->>'memeAmount'
      AND r.quote_amount::text=p.manifest->>'quoteAmount'
      AND r.treasury=p.inputs->>'treasury'
      AND r.gas_reserve_amount::text=p.inputs->>'reserve'
      AND v.meme_type=p.inputs->>'memeType' AND v.quote_type=p.inputs->>'quoteType'
      AND v.origin_id=p.inputs->>'originId';
END $$;

CREATE FUNCTION vault_waiting_rewards(expected_network TEXT, expected_fp TEXT, wallets TEXT[])
RETURNS TABLE(presale_id TEXT, vault_id TEXT, meme_type TEXT, quote_type TEXT, round_id TEXT,
  number TEXT, leaf_index BIGINT, beneficiary TEXT, meme_amount TEXT, quote_amount TEXT,
  reason TEXT, decided_at TIMESTAMPTZ, claim_deadline_ms TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE head RECORD;
BEGIN
  IF expected_network IS DISTINCT FROM 'mainnet' OR expected_fp IS NULL OR expected_fp !~ '^[0-9a-f]{64}$'
    OR wallets IS NULL OR cardinality(wallets) NOT BETWEEN 1 AND 50
    OR EXISTS(SELECT FROM unnest(wallets) w WHERE w IS NULL OR w !~ '^0x[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'invalid vault waiting reward scope';
  END IF;

  SELECT h.checkpoint,h.digest INTO head FROM chain_read_v1.checkpoint_headers h
  WHERE h.checkpoint=(
    SELECT min(c.checkpoint) FROM chain_read_v1.projection_coverage c
    WHERE c.network=expected_network AND c.deployment_fingerprint=expected_fp
      AND c.pipeline IN ('market','intake') AND c.fault_checkpoint IS NULL
    HAVING count(DISTINCT c.pipeline)=2
  );
  IF head.checkpoint IS NULL THEN RAISE EXCEPTION 'native vault waiting reward coverage unavailable'; END IF;
  PERFORM chain_read_v1.require_cut(expected_network,expected_fp,head.checkpoint,head.digest,ARRAY['market','intake']);

  RETURN QUERY
    SELECT CASE WHEN r.origin_kind='presale' THEN r.origin_id ELSE '0x' || repeat('0',64) END,
      r.vault_id, r.meme_type, r.quote_type, r.round_id, r.number, a.leaf_index::bigint,
      a.beneficiary, a.meme_amount::text, a.quote_amount::text, 'next'::text,
      r.published_at, r.claim_deadline_ms
    FROM vault_reward_publications(expected_network,expected_fp,NULL,wallets) r
    JOIN vault_reward_allocations a ON a.plan_id=r.plan_id
    WHERE a.beneficiary=ANY(wallets) AND (a.meme_amount>0 OR a.quote_amount>0)
      AND r.published_checkpoint<=head.checkpoint AND NOT r.closed
      AND NOT EXISTS(
        SELECT FROM chain_read_v1.vault_reward_payouts paid
        WHERE paid.round_id=r.round_id AND paid.index=a.leaf_index AND paid.vault_id=r.vault_id
          AND paid.checkpoint<=head.checkpoint
      )
    ORDER BY r.published_checkpoint,r.round_id,a.leaf_index;
END $$;

CREATE FUNCTION vault_published_reward_manifest(expected_network TEXT, expected_fp TEXT, target_round TEXT)
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_catalog AS $$
BEGIN
  IF expected_network IS DISTINCT FROM 'mainnet' OR expected_fp IS NULL OR expected_fp !~ '^[0-9a-f]{64}$'
    OR target_round IS NULL OR target_round !~ '^0x[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  RETURN (SELECT p.storage_url FROM vault_reward_publications(expected_network,expected_fp,target_round,NULL) p);
END $$;

DO $$
DECLARE had_create BOOLEAN := has_schema_privilege('blast_indexer', 'public', 'CREATE');
BEGIN
  IF NOT had_create THEN GRANT CREATE ON SCHEMA public TO blast_indexer; END IF;
  ALTER FUNCTION vault_reward_publications(TEXT,TEXT,TEXT,TEXT[]) OWNER TO blast_indexer;
  ALTER FUNCTION vault_waiting_rewards(TEXT,TEXT,TEXT[]) OWNER TO blast_indexer;
  ALTER FUNCTION vault_published_reward_manifest(TEXT,TEXT,TEXT) OWNER TO blast_indexer;
  IF NOT had_create THEN REVOKE CREATE ON SCHEMA public FROM blast_indexer; END IF;
END $$;
REVOKE ALL ON FUNCTION vault_reward_publications(TEXT,TEXT,TEXT,TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION vault_waiting_rewards(TEXT,TEXT,TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION vault_published_reward_manifest(TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault_waiting_rewards(TEXT,TEXT,TEXT[]) TO blast_web,blast_social;
GRANT EXECUTE ON FUNCTION vault_published_reward_manifest(TEXT,TEXT,TEXT) TO blast_web,blast_social,blast_replica;
