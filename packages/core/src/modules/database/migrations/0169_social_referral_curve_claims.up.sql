CREATE INDEX social_referral_events_curve_claim ON social_referral_events(entity_id, checkpoint, digest, event_index)
WHERE kind = 'curve_claim';
