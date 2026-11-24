-- Fixed treasury leaves carry no holder weight and cannot impersonate another recipient.
ALTER TABLE presale_daily_allocations DROP CONSTRAINT presale_daily_allocations_weight_check;
ALTER TABLE presale_daily_allocations ADD CONSTRAINT presale_daily_allocations_weight_check CHECK (
  weight > 0 OR (weight = 0 AND beneficiary = '0x818d6d7026632f82367a9ca2413a5bb28aeec2a1b8dedca919ef812577b4d0a2')
);
