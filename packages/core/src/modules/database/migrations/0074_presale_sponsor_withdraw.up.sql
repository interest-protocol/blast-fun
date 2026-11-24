-- Social feed UI-14 (canonical UI §14.2, Withdraw): the sponsor's `withdraw`
-- intent. A Privy embedded wallet ("Blast wallet") sends some of its own
-- coins to one Sui address and Blast's gas pool pays the network fee, as it
-- does for presale commits. The route checks the kind with
-- `evaluateWithdrawPolicy` (coin splits and merges, the coin resolver's
-- framework calls, exactly one transfer of split coins); a withdrawal acts on
-- no presale, so its reservation names none. Every other intent still names
-- exactly one presale. The open-reservation cap, the daily execution budget
-- and execute are unchanged.
ALTER TABLE presale_sponsor_reservations ALTER COLUMN presale_id DROP NOT NULL;

ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_intent_check;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_intent_check
  CHECK (intent IN ('commit', 'claim', 'settle', 'cancel', 'reward_claim', 'withdraw'));

ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_presale_by_intent
  CHECK ((presale_id IS NULL) = (intent = 'withdraw'));
