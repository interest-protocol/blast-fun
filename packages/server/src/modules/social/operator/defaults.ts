import { z } from "zod";
import { randomUUID } from "node:crypto";

import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { SOCIAL_DEFAULT_ACCOUNT_COUNT } from "@blast/core/modules/social/contracts/onboarding.ts";
import { socialOperatorCommand } from "./framework.ts";

/**
 * `defaults set <callsign1> … <callsignN>`: the accounts every account
 * follows by default, in order (positions 1 to N, N =
 * `SOCIAL_DEFAULT_ACCOUNT_COUNT`). Exactly N distinct callsigns of existing Blast Accounts; any other count, a duplicate or an
 * unknown callsign is refused and nothing changes. A member whose social row
 * does not exist yet gets one, as account resolution would create it. The
 * change applies to accounts whose onboarding is shown after it: follows
 * already applied stay as they are.
 */

const CALLSIGN = /^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/;

type Configured = { position: number; callsign: string };

/** The callsigns as typed (trimmed, lowercased, an optional leading `@`), or null to refuse them. */
export function parseDefaultCallsigns(args: readonly string[]): { callsigns: string[] } | null {
  const parsed = z.array(z.string().transform((value) => value.trim().toLowerCase().replace(/^@/, "")).pipe(z.string().regex(CALLSIGN)))
    .length(SOCIAL_DEFAULT_ACCOUNT_COUNT).refine((values) => new Set(values).size === values.length).safeParse(args);
  return parsed.success ? { callsigns: parsed.data } : null;
}

const CONFIGURED = `
  SELECT d.position, i.callsign
  FROM social_default_accounts d
  JOIN social_account_identities i ON i.account_id = d.account_id
  ORDER BY d.position`;

/** A member profile's account row, created as account resolution would create it. */
const ENSURE_MEMBER_ACCOUNTS = `
  INSERT INTO social_accounts (account_id, profile_id)
  SELECT input.account_id, p.profile_id
  FROM unnest($1::uuid[], $2::text[]) AS input(account_id, callsign)
  JOIN mission_control_profiles p ON p.callsign = input.callsign
  ON CONFLICT DO NOTHING`;

const ACCOUNTS_BY_CALLSIGN = `
  SELECT i.account_id
  FROM unnest($1::text[]) WITH ORDINALITY AS input(callsign, position)
  JOIN social_account_identities i ON i.callsign = input.callsign
  ORDER BY input.position`;

export const defaultsSet = socialOperatorCommand<{ callsigns: string[] }>({
  path: ["defaults", "set"],
  usage: `defaults set <callsign1> … <callsign${SOCIAL_DEFAULT_ACCOUNT_COUNT}>   (exactly ${SOCIAL_DEFAULT_ACCOUNT_COUNT} distinct existing accounts, in order)`,
  parse: parseDefaultCallsigns,
  run: async ({ callsigns }, { transaction }) => {
    // Serializes concurrent `defaults set` runs.
    await transaction.read("SELECT pg_advisory_xact_lock(hashtext('social_default_accounts'))");
    const before = (await transaction.read<Configured>(CONFIGURED)).rows.map((row) => row.callsign);
    await transaction.write("social_accounts", ENSURE_MEMBER_ACCOUNTS, [callsigns.map(() => randomUUID()), callsigns]);
    const accounts = await transaction.read<{ account_id: string }>(ACCOUNTS_BY_CALLSIGN, [callsigns]);
    if (accounts.rows.length !== callsigns.length) throw new OperatorError("OPERATOR_TARGET_NOT_FOUND");
    const accountIds = accounts.rows.map((row) => row.account_id);
    await transaction.write("social_default_accounts", "DELETE FROM social_default_accounts");
    await transaction.write(
      "social_default_accounts",
      `INSERT INTO social_default_accounts (position, account_id)
       SELECT entry.position, entry.account_id
       FROM unnest($1::uuid[]) WITH ORDINALITY AS entry (account_id, position)`,
      [accountIds],
    );
    return {
      result: { before, after: callsigns },
      log: { action: "defaults.set", target: "*", before, after: callsigns },
    };
  },
});
