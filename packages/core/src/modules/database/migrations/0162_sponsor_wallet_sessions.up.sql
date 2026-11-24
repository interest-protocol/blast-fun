-- Outside wallets get Blast-paid gas too (owner ruling 2026-11-20,
-- reversing OA-17): a sign-in with Slush or another Sui wallet reserves sponsored gas
-- like a Privy account. Its reservations are keyed `sui:<address>` (the
-- social kit's subject) in `privy_did`, and that address must be the sender.
-- The migration runs in one transaction, so the scan of this small table holds
-- the lock either way; fail fast rather than queue sponsor writes behind it.
SET LOCAL lock_timeout = '3s';
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_privy_did_check;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_privy_did_check
  CHECK (privy_did ~ '^did:privy:[A-Za-z0-9_-]{1,128}$' OR privy_did = 'sui:' || sender);
