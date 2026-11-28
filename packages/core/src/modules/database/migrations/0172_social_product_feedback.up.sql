CREATE TABLE social_product_feedback (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('feature_request', 'feedback')),
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX ON social_product_feedback (created_at DESC, id DESC);
CREATE INDEX ON social_product_feedback (kind, created_at DESC, id DESC);

REVOKE ALL ON social_product_feedback FROM PUBLIC;
GRANT SELECT ON social_product_feedback TO blast_web;
GRANT INSERT (id, kind, message), UPDATE (reviewed_at)
  ON social_product_feedback TO blast_web;
