ALTER TABLE social_competitions
  DROP CONSTRAINT IF EXISTS social_competitions_prize_rules,
  DROP CONSTRAINT IF EXISTS social_competitions_prize_complete,
  DROP COLUMN IF EXISTS prize_coin_symbol,
  DROP COLUMN IF EXISTS prize_coin_type,
  DROP COLUMN IF EXISTS prize_amount;
