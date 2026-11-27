import {
  SOCIAL_CONFIG_DEFAULTS,
  SOCIAL_CONFIG_KEYS,
  type SocialConfigKey,
  type SocialConfigValue,
} from "@blast/core/modules/social/contracts/config.ts";
import { normalizeBlockedTerm, parseSocialConfigInput, parseSocialConfigKey, socialConfigFromRows } from "@blast/core/modules/social/config/values.ts";
import { backfill } from "./backfill.ts";
import { SALE_METADATA_OPERATOR_COMMANDS } from "../sales/operator.ts";
import { REFERRAL_PAYMENT_RECORD } from "../referrals/operator.ts";
import { defaultsSet } from "./defaults.ts";
import { socialOperatorCommand, type SocialOperatorCommand } from "./framework.ts";
import { saleTrustClear, saleTrustHistory, saleTrustList, saleTrustSet } from "./trust.ts";
import { coinTrustHistory, coinTrustList } from "./coin-trust.ts";

/**
 * The tuning and blocked-term commands. Each reads and writes the primary
 * directly, never the 30 s reader cache, so what it prints is what is stored.
 */

type StoredRow = { key: string; value: unknown; updated_at: Date; updated_by: string };

const configGet = socialOperatorCommand<{ key: SocialConfigKey | null }>({
  path: ["config", "get"],
  usage: `config get [${SOCIAL_CONFIG_KEYS.join("|")}]`,
  parse: (args) => {
    if (args.length === 0) return { key: null };
    const key = args.length === 1 ? parseSocialConfigKey(args[0]) : null;
    return key ? { key } : null;
  },
  run: async ({ key }, { transaction }) => {
    const { rows } = await transaction.read<StoredRow>(
      "SELECT key, value, updated_at, updated_by FROM social_config ORDER BY key",
    );
    const config = socialConfigFromRows(rows);
    const keys = key ? [key] : SOCIAL_CONFIG_KEYS;
    const values = keys.map((name) => {
      const row = rows.find((candidate) => candidate.key === name);
      return {
        key: name,
        value: config[name],
        source: row ? "stored" : "initial",
        updatedAt: row?.updated_at.toISOString() ?? null,
        updatedBy: row?.updated_by ?? null,
      };
    });
    return {
      result: { values },
      log: { action: "config.get", target: key ?? "*", before: null, after: null },
    };
  },
});

const configSet = socialOperatorCommand<{ key: SocialConfigKey; value: SocialConfigValue }>({
  path: ["config", "set"],
  usage: "config set <key> <value>   (integers, decimals such as 2500.5, or comma-separated lists such as fire,rocket)",
  parse: (args) => {
    if (args.length !== 2) return null;
    const key = parseSocialConfigKey(args[0]);
    const value = key ? parseSocialConfigInput(key, args[1]) : null;
    return key && value !== null ? { key, value } : null;
  },
  run: async ({ key, value }, { operator, transaction }) => {
    // Serializes writers of one key, including the first, which has no row to lock.
    await transaction.read("SELECT pg_advisory_xact_lock(hashtext('social_config:' || $1))", [key]);
    const { rows } = await transaction.read<{ value: unknown }>("SELECT value FROM social_config WHERE key = $1", [key]);
    const before = rows[0] ? rows[0].value : SOCIAL_CONFIG_DEFAULTS[key];
    await transaction.write(
      "social_config",
      `INSERT INTO social_config (key, value, updated_at, updated_by)
       VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), operator.operatorId],
    );
    return {
      result: { key, before, after: value },
      log: { action: "config.set", target: key, before, after: value },
    };
  },
});

function oneTerm(args: readonly string[]): { term: string } | null {
  const term = args.length === 1 ? normalizeBlockedTerm(args[0]) : null;
  return term ? { term } : null;
}

const termsAdd = socialOperatorCommand<{ term: string }>({
  path: ["terms", "add"],
  usage: "terms add <term>   (quote a phrase; matched case-insensitively anywhere in new text)",
  parse: oneTerm,
  run: async ({ term }, { operator, transaction }) => {
    const { rowCount } = await transaction.write(
      "social_blocked_terms",
      `INSERT INTO social_blocked_terms (term, added_by) VALUES ($1, $2)
       ON CONFLICT (term) DO NOTHING`,
      [term, operator.operatorId],
    );
    const before = { blocked: rowCount === 0 };
    return {
      result: { term, added: rowCount === 1 },
      log: { action: "terms.add", target: term, before, after: { blocked: true } },
    };
  },
});

const termsRemove = socialOperatorCommand<{ term: string }>({
  path: ["terms", "remove"],
  usage: "terms remove <term>",
  parse: oneTerm,
  run: async ({ term }, { transaction }) => {
    const { rowCount } = await transaction.write(
      "social_blocked_terms",
      "DELETE FROM social_blocked_terms WHERE term = $1",
      [term],
    );
    return {
      result: { term, removed: rowCount === 1 },
      log: { action: "terms.remove", target: term, before: { blocked: rowCount === 1 }, after: { blocked: false } },
    };
  },
});

const termsList = socialOperatorCommand<Record<string, never>>({
  path: ["terms", "list"],
  usage: "terms list",
  parse: (args) => (args.length === 0 ? {} : null),
  run: async (_input, { transaction }) => {
    const { rows } = await transaction.read<{ term: string; added_at: Date; added_by: string }>(
      "SELECT term, added_at, added_by FROM social_blocked_terms ORDER BY term",
    );
    return {
      result: {
        terms: rows.map((row) => ({ term: row.term, addedAt: row.added_at.toISOString(), addedBy: row.added_by })),
      },
      log: { action: "terms.list", target: "*", before: null, after: null },
    };
  },
});

/**
 * Every `social:operator` command. Later tickets append their domain commands
 * (default accounts, moderation, attribution voiding, the backfill) here.
 */
export const SOCIAL_OPERATOR_COMMANDS: readonly SocialOperatorCommand[] = Object.freeze([
  configGet,
  configSet,
  termsAdd,
  termsRemove,
  termsList,
  defaultsSet,
  backfill,
  REFERRAL_PAYMENT_RECORD,
  saleTrustSet,
  saleTrustClear,
  saleTrustList,
  saleTrustHistory,
  // R3-23 for bonding-curve coins: reads only; the verified mark is set on the admin website.
  coinTrustList,
  coinTrustHistory,
  // R3-24: a sale's public details (history, clear, revert, launch date).
  ...SALE_METADATA_OPERATOR_COMMANDS,
]);
