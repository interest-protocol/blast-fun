ALTER TABLE social_accounts
  ADD COLUMN bio text CHECK (char_length(bio) BETWEEN 1 AND 160);
