import { readDigestJson } from "@blast/server/modules/social/transactions/digest-provenance.ts";
import { z } from "zod";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import {
  SOCIAL_ATOMS_MAX,
  SOCIAL_ATOMS_PATTERN,
  SOCIAL_INTENT_ROUTE,
  SOCIAL_TX_DIGEST_PATTERN,
  SOCIAL_USD_PATTERN,
  type SocialIntentRecorded,
  type SocialIntentWhyResult,
} from "@blast/core/modules/social/contracts/intents.ts";
import { SOCIAL_ENTRY_ID_PATTERN } from "@blast/core/modules/social/contracts/viewer-state.ts";
import { isVisible } from "@blast/server/modules/social/read-model/index.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialCaller, SocialRequestContext, SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { logTransaction, TransactionLogConflict } from "@blast/core/modules/social/transactions/log.ts";
import { validateWhy, type WhyTextRefusal } from "@blast/core/modules/social/whys/validate.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * Every code `validateWhy` can answer is one this route can report, so a
 * refusal the whys route would have thrown is reported here instead of
 * thrown. The assignment fails to compile if the two drift apart.
 */
const WHY_REFUSAL_IS_REPORTABLE: Readonly<Record<WhyTextRefusal, SocialIntentWhyResult>> = {
  why_empty: "why_empty",
  why_too_long: "why_too_long",
  why_invalid: "why_invalid",
  why_has_link: "why_has_link",
};

export type SocialIntentRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** Wallet provenance, checked before the first global digest reservation. */
  provenance: (caller: SocialCaller, digest: string, transactionBytes: unknown, signal: AbortSignal) => Promise<void>;
  /** The tuning values of this request (`getSocialConfig`): the presale-post thresholds of the visibility check. */
  config: () => Promise<SocialConfig>;
  /** `findBlockedTerm`: the blocked term the text contains, or null (cached 30 s). */
  findBlockedTerm: (text: string) => Promise<string | null>;
}>;

/** The registration. `ON CONFLICT DO NOTHING` makes a retried call write nothing. */
export const INTENT_INSERT_SQL = `INSERT INTO social_intents (tx_digest, account_id, action, presale_id, source_entry_id, why_text)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (tx_digest) DO NOTHING`;

/** Who holds a digest, by the primary key. Read before the insert, and again after a conflict. */
export const INTENT_OWNER_SQL = "SELECT account_id FROM social_intents WHERE tx_digest = $1";

type Outcome = "recorded" | "duplicate" | "taken";

/** A required string body field, or `invalid_request` (the schema is closed, so this is the type check). */
function text(value: unknown): string {
  return socialInput(z.string(), value);
}

/** An optional body field that must match `pattern`, or `invalid_request` (a malformed fact, not a malformed id). */
function optional(value: unknown, pattern: RegExp): string | null {
  if (value === undefined) return null;
  return socialInput(z.string().regex(pattern), value);
}

/**
 * The commit's transaction-log facts (R3-27), as the dialog built them: the
 * coin the commitment is counted in, its atoms, and its dollar value. An
 * amount names its coin, and atoms are a u64.
 */
function commitFacts(body: Readonly<Record<string, unknown>>) {
  const quoteType = optional(body.quote_type, COIN_TYPE);
  const quoteAmount = optional(body.quote_amount, SOCIAL_ATOMS_PATTERN);
  const usdValue = optional(body.usd_value, SOCIAL_USD_PATTERN);
  if (quoteAmount !== null && (quoteType === null || BigInt(quoteAmount) > SOCIAL_ATOMS_MAX)) {
    throw new SocialRouteError("invalid_request");
  }
  return { quoteType, quoteAmount, usdValue };
}

/** A body field that must match an id pattern, or `invalid_parameter` naming it. */
function identifier(value: unknown, pattern: RegExp, parameter: string): string {
  const raw = text(value);
  if (!z.string().regex(pattern).safeParse(raw).success) throw new SocialRouteError("invalid_parameter", { extra: { parameter } });
  return raw;
}

/**
 * The intents route (contract in `contracts/intents.ts`).
 *
 * `register.POST` (T-024): account required, bucket `social_intent`. After the
 * kit: the closed body, the action (only `commit`; the swap feature's `buy`
 * and `sell` are `invalid_request`), the three ids, and the why through the
 * shared `validateWhy` plus the blocked terms. Then one primary transaction
 * that reads the digest's owner by its primary key, resolves the source item's
 * visibility once (`isVisible`; invisible is stored as null, because
 * attribution is decided here and never re-checked), and inserts the row as
 * `pending`. The worker resolves it (T-026).
 *
 * The three answers come from one row: `201 recorded` when the insert wrote
 * it, `200 duplicate` when this account already holds the digest, and
 * `409 digest_taken` when another account does. A refused why is reported in
 * the `201` and not stored; the intent is still recorded, because the caller
 * holds a signed transaction and is about to execute it.
 *
 * The why's text never leaves this function except into the row: not into a
 * log line, a metric, an error body or the answer (AC-130). Only its code
 * does.
 */
export function createSocialIntentRoutes(dependencies: SocialIntentRouteDependencies) {
  const { kit, config, findBlockedTerm } = dependencies;

  async function register(context: SocialRequestContext): Promise<Response> {
    const body = await readDigestJson(
      context.request,
      ["action", "presale_id", "tx_digest"],
      ["source_entry_id", "why", "quote_type", "quote_amount", "usd_value", "transaction_bytes"],
    );
    // `buy` and `sell` are the swap feature's; the column already allows them.
    socialInput(z.literal("commit"), body.action);
    const presaleId = identifier(body.presale_id, SUI_OBJECT_ID_PATTERN, "presale_id");
    const digest = identifier(body.tx_digest, SOCIAL_TX_DIGEST_PATTERN, "tx_digest");
    const sourceEntryId =
      body.source_entry_id === undefined ? null : identifier(body.source_entry_id, SOCIAL_ENTRY_ID_PATTERN, "source_entry_id");
    const facts = commitFacts(body);

    let whyResult: SocialIntentWhyResult | null = null;
    let whyText: string | null = null;
    if (body.why !== undefined) {
      const checked = validateWhy(text(body.why));
      if (!checked.ok) whyResult = WHY_REFUSAL_IS_REPORTABLE[checked.code];
      else if ((await findBlockedTerm(checked.text)) !== null) whyResult = "blocked_term";
      else {
        whyResult = "accepted";
        whyText = checked.text;
      }
    }

    await dependencies.provenance(context.caller!, digest, body.transaction_bytes, context.request.signal);
    const values = await config();
    const accountId = context.account!.account_id;
    const outcome = await context.transaction<Outcome>(async (social) => {
      const held = await social.read<{ account_id: string }>(INTENT_OWNER_SQL, [digest]);
      const owner = held.rows[0]?.account_id;
      if (owner !== undefined) return owner === accountId ? "duplicate" : "taken";
      // Decided once, here: a source nobody could see at registration credits
      // nobody later, whatever happens to its visibility afterwards.
      const source =
        sourceEntryId !== null &&
        (await isVisible(social, sourceEntryId, { bigCommitUsd: values.big_commit_usd, bigTradeUsd: values.big_trade_usd }))
          ? sourceEntryId
          : null;
      const written = await social.write("social_intents", INTENT_INSERT_SQL, [
        digest,
        accountId,
        "commit",
        presaleId,
        source,
        whyText,
      ]);
      if (written.rowCount === 1) {
        // R3-27: the commit's row in the account's transaction log, in the
        // same transaction, so the two commit or roll back together. The
        // worker settles it once the chain shows the transaction (T-026).
        try {
          await logTransaction(
            social,
            {
              accountId,
              kind: "commit",
              idempotencyKey: `commit:${digest}`,
              presaleId,
              quoteType: facts.quoteType,
              quoteAmount: facts.quoteAmount,
              usdValue: facts.usdValue,
            },
            { state: "submitted", digest },
          );
        } catch (error) {
          // A row this key already holds with other facts (an intent that
          // expired and is registered again differently) stands as it is: the
          // log never blocks the registration, and the registration never
          // blocks the transaction.
          if (!(error instanceof TransactionLogConflict)) throw error;
        }
        return "recorded";
      }
      // Another request inserted the same digest between the read and the
      // write. Whoever got there first owns it.
      const after = await social.read<{ account_id: string }>(INTENT_OWNER_SQL, [digest]);
      return after.rows[0]?.account_id === accountId ? "duplicate" : "taken";
    }, { label: "social.intent" });

    if (outcome === "taken") throw new SocialRouteError("digest_taken");
    // A duplicate changed nothing, so the first registration's why stands and
    // this answer claims nothing about it.
    const answer: SocialIntentRecorded = { status: outcome, why: outcome === "duplicate" ? null : whyResult };
    return context.json(answer, outcome === "duplicate" ? 200 : 201);
  }

  return Object.freeze({
    register: Object.freeze({
      POST: kit.route({ name: SOCIAL_INTENT_ROUTE, auth: "account", account: "required", bucket: "social_intent" }, register),
    }),
  });
}

export type SocialIntentRoutes = ReturnType<typeof createSocialIntentRoutes>;
