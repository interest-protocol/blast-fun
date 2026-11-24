import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { makeSeasonZeroCardFixtures } from "../../mission-control/card-renderer/fixtures.ts";
import { createSeasonZeroCardRecord } from "@blast/core/modules/mission-control/card-renderer/contract.ts";

/** Disposable database data; Countdown uses the profile/feed fixture's Kai and Quasar uses Mira. */
export async function seedCardIdentities(pool: Pool) {
  const fixtures = await makeSeasonZeroCardFixtures();
  const cards = [];
  for (const { record: sample } of fixtures) {
    const id = randomUUID(), membership = randomUUID(), cardId = randomUUID();
    const callsign = sample.edition === "countdown" ? "kaimoreno" : sample.edition === "quasar" ? "mirachen" : sample.edition === "blast-launch-day" ? "crew_launch_day" : `crew_${sample.edition.replaceAll("-", "_")}`;
    const record = createSeasonZeroCardRecord({ ...sample, cardId, callsign });
    const zero = record.crew <= 100;
    await pool.query(`INSERT INTO mission_control_profiles
      (profile_id, privy_did, x_subject, sui_address, provider_wallet_reference, callsign, display_name, disclosure_version, disclosure_accepted_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6, 'fixture-v1', now())`,
    [id, `did:privy:${callsign}`, `x-${callsign}`, `0x${record.crew.toString(16).padStart(64, "0")}`, `wallet-${callsign}`, callsign]);
    await pool.query("INSERT INTO mission_control_account_identities (profile_id, provider, provider_subject, verified_at) VALUES ($1, 'privy', $2, now())", [id, `did:privy:${callsign}`]);
    await pool.query(`INSERT INTO mission_control_season_memberships
      (membership_id, allocation_id, card_id, season_id, profile_id, crew_number, fleet, owner_title, zero_fleet, gold)
      VALUES ($1, $2, $3, 'season-zero', $4, $5, 'Recon', $6, $7, $7)`,
    [membership, randomUUID(), cardId, id, record.crew, zero ? "Zero Fleet Commando" : "Recon Fleet", zero]);
    await pool.query(`INSERT INTO mission_control_cards
      (card_id, profile_id, membership_id, record_schema, record_version, card_record, created_at, published_at)
      VALUES ($1, $2, $3, $4, $5, $6, now(), $7)`,
    [cardId, id, membership, record.schema, record.version, JSON.stringify(record), sample.edition === "blast-launch-day" ? null : new Date()]);
    await pool.query("INSERT INTO social_accounts (account_id, profile_id, onboarded_at) VALUES ($1, $1, now())", [id]);
    cards.push({ id, callsign, record });
  }
  return cards;
}
