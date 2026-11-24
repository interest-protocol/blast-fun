ALTER TABLE mission_control_invitation_allocations
  DROP CONSTRAINT mission_control_invitation_allocations_policy_version_check,
  DROP CONSTRAINT mission_control_invitation_allocation_weight_check,
  ADD COLUMN x_premium_verified BOOLEAN;

ALTER TABLE mission_control_invitation_allocations
  ADD CONSTRAINT mission_control_invitation_allocations_policy_version_check
    CHECK (policy_version IN ('season-zero-v1', 'season-zero-v2')),
  ADD CONSTRAINT mission_control_invitation_allocation_weight_check CHECK (
    (
      policy_version = 'season-zero-v1'
      AND x_premium_verified IS NULL
      AND (
        (secure_draw BETWEEN 0 AND 399 AND code_count = 0) OR
        (secure_draw BETWEEN 400 AND 799 AND code_count = 1) OR
        (secure_draw BETWEEN 800 AND 949 AND code_count = 2) OR
        (secure_draw BETWEEN 950 AND 989 AND code_count = 3) OR
        (secure_draw BETWEEN 990 AND 998 AND code_count = 4) OR
        (secure_draw = 999 AND code_count = 5)
      )
    ) OR (
      policy_version = 'season-zero-v2'
      AND x_premium_verified = FALSE
      AND secure_draw = 0
      AND code_count = 0
    ) OR (
      policy_version = 'season-zero-v2'
      AND x_premium_verified = TRUE
      AND secure_draw BETWEEN 0 AND 2
      AND code_count = secure_draw + 1
    )
  );
