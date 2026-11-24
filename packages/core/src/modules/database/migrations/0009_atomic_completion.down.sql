DROP TRIGGER IF EXISTS mission_control_invitation_lifecycle_immutable
  ON mission_control_invitation_codes;
DROP TRIGGER IF EXISTS mission_control_cards_immutable_identity
  ON mission_control_cards;
DROP TRIGGER IF EXISTS mission_control_completion_idempotency_immutable
  ON mission_control_completion_idempotency;
DROP TRIGGER IF EXISTS mission_control_referrals_immutable
  ON mission_control_referrals;
DROP TRIGGER IF EXISTS mission_control_invitation_allocations_immutable
  ON mission_control_invitation_allocations;
DROP FUNCTION IF EXISTS mission_control_guard_invitation_lifecycle();
DROP FUNCTION IF EXISTS mission_control_guard_card_identity();
DROP FUNCTION IF EXISTS mission_control_guard_completion_immutable();
DROP INDEX IF EXISTS mission_control_invitation_codes_allocation_order_unique;
DROP INDEX IF EXISTS mission_control_invitation_codes_owner_idx;
ALTER TABLE mission_control_invitation_codes
  DROP CONSTRAINT IF EXISTS mission_control_invitation_code_consumption_check,
  DROP CONSTRAINT IF EXISTS mission_control_invitation_code_allocation_order_check,
  DROP COLUMN IF EXISTS consumed_by_profile_id,
  DROP COLUMN IF EXISTS allocation_ordinal,
  DROP COLUMN IF EXISTS source_allocation_id;
DROP TABLE IF EXISTS mission_control_completion_idempotency;
DROP TABLE IF EXISTS mission_control_cards;
DROP TABLE IF EXISTS mission_control_referrals;
DROP TABLE IF EXISTS mission_control_invitation_allocations;
