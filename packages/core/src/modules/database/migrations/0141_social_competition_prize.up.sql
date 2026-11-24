-- The competition card's "Prize pool" as a figure ("25,000 WAL"): an amount
-- in whole coins of a named coin, beside the free-text `prize_description`.
-- The three are set together or not at all, and like a description they need
-- the organizer's rules link. Existing competitions keep none (insert-only:
-- a published configuration never changes).
ALTER TABLE social_competitions
  ADD COLUMN prize_amount NUMERIC CHECK (prize_amount > 0 AND prize_amount < 1e20 AND scale(prize_amount) <= 9),
  ADD COLUMN prize_coin_type TEXT CHECK (char_length(prize_coin_type) BETWEEN 8 AND 512),
  ADD COLUMN prize_coin_symbol TEXT CHECK (char_length(prize_coin_symbol) BETWEEN 1 AND 20),
  ADD CONSTRAINT social_competitions_prize_complete CHECK (
    (prize_amount IS NULL) = (prize_coin_type IS NULL) AND (prize_coin_type IS NULL) = (prize_coin_symbol IS NULL)
  ),
  ADD CONSTRAINT social_competitions_prize_rules CHECK (prize_amount IS NULL OR rules_url IS NOT NULL);
