-- Balance diagnostics are immutable facts of the original attempt, including on replay.
ALTER TABLE social_swap_intents ADD COLUMN balance_failure JSONB
  CHECK (balance_failure IS NULL OR COALESCE((
    state = 'failed' AND failure_code = 'insufficient_balance'
    AND jsonb_typeof(balance_failure) = 'object'
    AND balance_failure ?& ARRAY['reason', 'coin_type', 'required_atoms', 'available_atoms']
    AND balance_failure->>'reason' IN ('input', 'gas')
    AND char_length(balance_failure->>'coin_type') BETWEEN 8 AND 512
    AND balance_failure->>'required_atoms' ~ '^(0|[1-9][0-9]{0,19})$'
    AND balance_failure->>'available_atoms' ~ '^(0|[1-9][0-9]{0,19})$'
  ), false));
