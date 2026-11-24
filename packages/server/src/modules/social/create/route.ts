import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import {
  SOCIAL_DRAFT_COVER_PATH,
  SOCIAL_DRAFT_LOGO_PATH,
  SOCIAL_DRAFT_PATH,
  SOCIAL_DRAFT_PUBLISH_PATH,
  SOCIAL_DRAFT_PUBLISHED_PATH,
} from "@blast/core/modules/backend-api/private/social-create-contracts.ts";
import { settledAll } from "@blast/server/lib/settled-all.ts";
import { deploymentFingerprint } from "@interest-protocol/blast-sdk/deployments";
import { mainnetIdentity } from "@blast/core/modules/presale/deployment/mainnet-identity.ts";
import type { StoredCover } from "@blast/server/modules/social/sales/contracts.ts";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";

import { bluefinDraftIssue, type BluefinCreateOptions } from "@blast/core/modules/social/create/bluefin-options.ts";
import { cetusDraftIssue, type CreateCetusTiers } from "@blast/core/modules/social/create/cetus-options.ts";

import { Transaction } from "@mysten/sui/transactions";
import { isValidStructTag, isValidSuiObjectId, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import { recordMetric, timed } from "@blast/core/lib/metrics.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import type { PresaleDeploymentState, PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { createDraftRequestSchema, CREATE_DRAFT_BODY_LIMIT_BYTES, CREATE_DRAFT_ID_PATTERN, CREATE_LOGO_MAX_BYTES, CREATE_QUOTES, CREATE_QUOTE_TYPE, createQuoteOf, SOCIAL_CREATE_DRAFT_COVER_DELETE_ROUTE, SOCIAL_CREATE_DRAFT_COVER_ROUTE, SOCIAL_CREATE_DRAFT_DELETE_ROUTE, SOCIAL_CREATE_DRAFT_LOGO_ROUTE, SOCIAL_CREATE_DRAFT_PUBLISH_ROUTE, SOCIAL_CREATE_DRAFT_PUBLISHED_ROUTE, SOCIAL_CREATE_DRAFT_READ_ROUTE, SOCIAL_CREATE_DRAFT_SAVE_ROUTE, SOCIAL_CREATE_DRAFTS_ROUTE, type CreateAllowlistSummary, type CreateDraft, type CreateDraftResponse, type CreateFeePolicy, type CreateIssue, type CreatePublishPlan, type CreateQuotePrice } from "@blast/core/modules/social/contracts/create.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/modules/social/contracts/portfolio.ts";
import { minimumRaiseIssue } from "@blast/core/modules/social/create/minimum-raise.ts";
import type { BlockedTermFinder } from "@blast/server/modules/social/accounts/creation.ts";
import type { SocialSaleMetadataResponse } from "@blast/core/modules/social/contracts/sales.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { SALE_COVER_IMAGE, draftCoverFolder, readCoverUpload, storeCover, type SaleCoverStore } from "@blast/server/modules/social/sales/cover.ts";
import type { SaleEditorSource } from "@blast/server/modules/social/sales/editor.ts";
import { publicCover, publicSaleMetadata, readStoredSaleMetadata, writeSaleMetadata, type SaleMetadataChange } from "@blast/server/modules/social/sales/store.ts";
import { normalizeSaleTagline } from "@blast/core/modules/social/sales/validate.ts";
import { readSocialBody, type SocialRequestContext, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createPresaleTransaction, publishAvailability, registerCurrencyTransaction, type CoinTemplate, type FeePolicySource } from "@blast/server/modules/social/create/chain.ts";
import { sanitizeSquareImage, storeSquareImage } from "@blast/server/modules/social/square-image.ts";
import { CREATE_LOGO_FOLDER, CREATE_LOGO_IMAGE } from "@blast/server/modules/social/create/logo.ts";
import { DraftShapeError, parseDraft, sameDraft } from "@blast/core/modules/social/create/model.ts";
import { createIssues, presaleArgs } from "@blast/core/modules/social/create/presale-args.ts";
import { deleteDraft, draftDetailColumns, parseDraftPage, readDraft, readDraftPage, recordDraftPublished, saveDraft, setDraftCover, setDraftLogo, type DraftRow } from "@blast/server/modules/social/create/store.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { sponsorAccountKey, type SponsorCaller } from "@blast/server/modules/sponsor/caller.ts";
import { coinKindProof, legacySponsorshipTime, readPublishApproval, recordPublishApproval, sponsoredCoinDigest, type CoinPublication, type PublicationCoin } from "./publish-approval.ts";

/** The public store the coin logos go to (the launch-asset Blob store). */
export type CreateLogoStore = Readonly<{
  write(pathname: string, bytes: Buffer, contentType: string): Promise<Readonly<{ url: string }>>;
}>;

/** The Quote types and migration witnesses the deployed `CreationPolicy` admits, normalized; null when unreadable. */
export type CreationPolicyReader = (identity: PresaleRuntimeIdentity) => Promise<Readonly<{ quotes: readonly string[]; witnesses: readonly string[] }> | null>;

export type SocialCreateRoutesDependencies = Readonly<{
  kit: SocialRouteKit;
  feePolicy: FeePolicySource;
  /**
   * The allowlist `id` as its owner uploaded it through
   * `POST /api/presale/allowlists` (a Privy sign-in owns it by DID), or null.
   */
  allowlist: (id: string, ownerDid: string) => Promise<CreateAllowlistSummary | null>;
  logoStore: () => CreateLogoStore | null;
  deployment: () => PresaleDeploymentState;
  /** The deployment identity once its node answers with the same chain (`PresaleDeploymentGate.authorize`). */
  authorize: (venue: CreateDraft["venue"], signal: AbortSignal) => Promise<PresaleRuntimeIdentity>;
  creationPolicy: CreationPolicyReader;
  cetusTiers: () => Promise<CreateCetusTiers | null>;
  bluefinOptions: () => Promise<BluefinCreateOptions>;
  /** The standalone presale coin template. */
  template: CoinTemplate | null;
  /** The account's wallet addresses (the publishing wallet must be one of them). */
  wallets: (accountId: string) => Promise<readonly string[]>;
  /** The most drafts one account keeps (`SOCIAL_CREATE_DRAFT_LIMIT`, default 25). */
  draftLimit: number;

  /** R3-25: the public store a draft's cover goes to (and a replaced one leaves), or null when uploads are off. */
  coverStore: () => SaleCoverStore | null;
  /** R3-25: who holds a sale's `PresaleCap` (R3-24), for recording the sale a draft became. */
  editor: SaleEditorSource;
  /** R3-25: a published tagline is the sale's description only without a blocked term. */
  findBlockedTerm: BlockedTermFinder;
  /** Standalone reads on the primary; without it reads run in a kit transaction. */
  database?: () => ReadableDatabase;
  /**
   * R3-42: SUI's `chain_read_v1.prices` row, the rate the quote picker
   * converts at; null when unavailable, and then SUI
   * is not offered for conversion.
   */
  quotePrice: () => Promise<CreateQuotePrice | null>;
  raiseQuotePrice: (quoteType: string) => Promise<CreateQuotePrice | null>;
  coinPublication: (coin: PublicationCoin, creator: string, identity: PresaleRuntimeIdentity, signal: AbortSignal) => Promise<CoinPublication | null>;
  prepareWalletPublication: (transaction: Transaction, signal: AbortSignal) => Promise<Readonly<{ transaction: string; digest: string }>>;
  /** Sponsors only the transaction this route built, after checking the draft and creator. */
  sponsorCreation?: (request: Readonly<{ caller: SponsorCaller; sender: string; transaction: Transaction; ip: string; signal: AbortSignal }>) => Promise<NonNullable<CreatePublishPlan["steps"][number]["sponsorship"]>>;
  /** The clock a draft's scheduled start is checked against (default `Date.now`). */
  now?: () => number;
}>;

/**
 * R3-42: an uploaded list's caps in whole coins of the list's own quote (to
 * the cent: USDC's 6 decimals, SUI's 9), and that quote; a quote Create does
 * not raise reads at USDC's decimals and is named, so the form asks for a
 * new list.
 */
export function allowlistCapRange(found: Readonly<{ root: string; leafCount: number; minCap: bigint; maxCap: bigint; quote: string }>) {
  const quoteType = normalizeStructTag(found.quote);
  const decimals = createQuoteOf(quoteType)?.decimals ?? 6;
  const coins = (atoms: bigint) => Number(atoms / 10n ** BigInt(decimals - 2)) / 100;
  return { root: found.root, leaf_count: found.leafCount, min_cap: coins(found.minCap), max_cap: coins(found.maxCap), quote_type: quoteType };
}

/** Quotes admitted by the deployed policy, with a conversion price when required. */
export function offeredQuotes(price: CreateQuotePrice | null, allowed?: readonly string[] | null): readonly string[] {
  const allowedQuotes = allowed === undefined ? null : new Set(allowed ?? []);
  return CREATE_QUOTES.filter((quote) => (!allowedQuotes || allowedQuotes.has(quote.quote_type)) && (quote.symbol !== "SUI" || price !== null)).map((quote) => quote.quote_type);
}

type Context = SocialRequestContext;

const DRAFT_PATHS = [SOCIAL_DRAFT_PATH, SOCIAL_DRAFT_LOGO_PATH, SOCIAL_DRAFT_COVER_PATH, SOCIAL_DRAFT_PUBLISHED_PATH, SOCIAL_DRAFT_PUBLISH_PATH] as const;

function draftIdOf(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const id = DRAFT_PATHS.map((path) => routeSegments(path, pathname)).find((segments) => segments !== null)?.id ?? "";
  socialInput(z.string().regex(CREATE_DRAFT_ID_PATTERN), id, "not_found");
  return id;
}

async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new SocialRouteError("invalid_request");
  const bytes = await readSocialBody(request, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SocialRouteError("invalid_request");
  }
  socialInput(z.record(z.string(), z.unknown()), value);
  // Keep every JSON key for the closed envelope check, including own __proto__.
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  socialInput(z.strictObject(Object.fromEntries([
    ...required.map((key) => [key, z.unknown().nonoptional()]),
    ...optional.map((key) => [key, z.unknown().optional()]),
  ])), body);
}

function versionOf(value: unknown): number {
  return socialInput(createDraftRequestSchema.shape.version, value);
}

function draftOf(value: unknown): CreateDraft {
  try {
    return parseDraft(value);
  } catch (error) {
    if (error instanceof DraftShapeError) throw new SocialRouteError("invalid_request", { extra: { field: error.field } });
    throw error;
  }
}

function storedDraftOf(value: unknown): CreateDraft {
  try {
    return parseDraft(value);
  } catch (error) {
    if (error instanceof DraftShapeError) {
      recordMetric("social.create", { operation: "read", outcome: "stored_draft_invalid" });
      throw new SocialRouteError("service_unavailable");
    }
    throw error;
  }
}

/** The caller's DID when it signed in through Privy (allowlists are owned by DID). */
const privyDid = (context: Context): string | null => (context.caller?.kind === "privy" ? context.caller.did : null);

/**
 * The Create routes (contract in `contracts/create.ts`): the signed-in
 * account's own drafts only, keyed by the account the kit resolved, every
 * answer `Cache-Control: private, no-store`.
 *
 * - Reads count in `social_read`; saves, deletes and publish plans in
 *   `social_create`; logo uploads in `social_create_logo`.
 * - A save is one transaction: an advisory lock per account (creates count
 *   the account's drafts under it), then one conditional insert or update.
 * - Issues are computed with Blast's current rates (`feePolicy`) on every
 *   answer, so the page and the server agree on what is left to fix.
 *
 * Metrics: `social.create` with `operation` through `timed` (reads sampled),
 * plus `outcome` for refusals worth counting. No draft content, address or
 * DID reaches a metric.
 */
export function createSocialCreateRoutes(dependencies: SocialCreateRoutesDependencies) {
  const { kit, database } = dependencies;
  const now = dependencies.now ?? Date.now;
  const account = { auth: "account", account: "required", cache: "private" } as const;

  function read<Result>(context: Context, label: string, operation: (db: ReadableDatabase) => Promise<Result>): Promise<Result> {
    return database ? operation(database()) : context.transaction((social) => operation(social), { label });
  }

  async function raiseIssue(draft: CreateDraft): Promise<CreateIssue | null> {
    const price = draft.quote_type === CREATE_QUOTE_TYPE ? null : await dependencies.raiseQuotePrice(draft.quote_type);
    const age = price ? now() - price.as_of_ms : Number.NaN;
    const rate = price && age >= 0 && age <= PORTFOLIO_PRICE_MAX_AGE_MS ? price.usd_price : null;
    return minimumRaiseIssue(draft, rate);
  }

  async function approvedPublication(context: Context, row: DraftRow, input: StepInput, coin: PublicationCoin): Promise<boolean> {
    const { creator, identity } = input;
    const publication = await dependencies.coinPublication(coin, creator, identity, context.request.signal);
    if (!publication) return false;
    const accountId = context.account!.account_id;
    const { digest } = publication;
    const approval = await read(context, "social.create_publish_approval", (db) => readPublishApproval(db, row, creator, digest, accountId));
    if (approval.matches) return true;

    // Older clients have the on-chain coin but no admission record. Match the
    // old publish template and only recover terms saved before the rollout.
    const rollout = approval.legacyUntilMs;
    if (rollout === null || row.updatedAtMs > rollout) return false;
    let sponsoredAt = null;
    if (context.caller) {
      const key = sponsorAccountKey(context.caller);
      sponsoredAt = await read(context, "social.create_legacy_sponsorship", (db) => legacySponsorshipTime(db, digest, key, creator));
    }
    const startedAt = sponsoredAt ?? publication.timestampMs;
    if (startedAt === null || startedAt < row.updatedAtMs || startedAt > rollout) return false;
    if (publication.kindProof !== await coinKindProof(await coinPublishTransaction(input))) return false;
    return context.transaction((db) => recordPublishApproval(db, row, accountId, creator, digest), { label: "social.create_legacy_publish_approval" });
  }

  async function preparePublishStep(context: Context, row: DraftRow, creator: string, sponsored: boolean, plan: CreatePublishPlan["steps"][number]) {
    async function approveCoin(digest: string) {
      const saved = await context.transaction((db) =>
        recordPublishApproval(db, row, context.account!.account_id, creator, digest),
      { label: "social.create_publish_approval" });
      if (!saved) throw new SocialRouteError("draft_conflict");
    }
    if (sponsored) {
      // Privy accounts and external wallet sessions can both use sponsorship.
      if (!context.caller) throw new SocialRouteError("unauthorized");
      if (!dependencies.sponsorCreation || !plan.transaction) throw new SocialRouteError("service_unavailable");
      const sponsorship = await dependencies.sponsorCreation({ caller: context.caller, sender: creator, transaction: Transaction.from(plan.transaction), ip: context.client.rateKey, signal: context.request.signal }).catch((error: unknown) => {
        if (error instanceof PresaleRouteError && (error.code === "budget_exceeded" || error.code === "rate_limited")) {
          throw new SocialRouteError("rate_limited", { extra: error.extra, retryAfterSeconds: error.retryAfterSeconds ?? undefined });
        }
        throw error;
      });
      if (plan.kind === "publish_coin") await approveCoin(sponsoredCoinDigest(sponsorship.transaction_bytes));
      return { ...plan, sponsorship };
    }
    if (plan.kind === "publish_coin" && plan.transaction) {
      const prepared = await dependencies.prepareWalletPublication(Transaction.from(plan.transaction), context.request.signal);
      await approveCoin(prepared.digest);
      return { ...plan, transaction: prepared.transaction };
    }
    return plan;
  }

  async function respond(row: DraftRow, fees?: CreateFeePolicy): Promise<CreateDraftResponse> {
    const draft = storedDraftOf(row.body);
    const identity = mainnetIdentity(dependencies.deployment());
    const [feePolicy, suiPrice, policy, cetusTiers, bluefinOptions] = await settledAll([
      fees ?? dependencies.feePolicy(),
      dependencies.quotePrice(),
      identity ? dependencies.creationPolicy(identity) : Promise.resolve(undefined),
      dependencies.cetusTiers(),
      dependencies.bluefinOptions(),
    ]);
    return {
      draft_id: row.draftId,
      version: row.version,
      created_at_ms: row.createdAtMs,
      updated_at_ms: row.updatedAtMs,
      draft,
      logo_url: row.logoUrl,
      cover: publicCover(row.cover),
      published_presale_id: row.publishedPresaleId,
      allowlist: row.allowlist,
      issues: [...createIssues(draft, { fees: feePolicy, allowlist: row.allowlist, nowMs: now() }), ...[cetusDraftIssue(draft, cetusTiers), bluefinDraftIssue(draft, bluefinOptions)].filter((issue) => issue !== null)],
      fee_policy: feePolicy,
      quotes: offeredQuotes(suiPrice, policy === undefined ? undefined : policy?.quotes ?? null),
      sui_price: suiPrice,
      cetus_tiers: cetusTiers,
      bluefin_options: bluefinOptions,
    };
  }

  async function ownedDraft(context: Context, label: string): Promise<DraftRow> {
    const row = await read(context, label, (db) => readDraft(db, context.account!.account_id, draftIdOf(context.request)));
    if (!row) throw new SocialRouteError("not_found");
    return row;
  }

  async function ownedDraftRequest(context: Context, maximumBytes: number) {
    const row = await ownedDraft(context, "social.create_read");
    return { row, body: await readJson(context.request, maximumBytes) };
  }

  /** R3-25: sets or removes the draft's cover; a draft that is gone is not found, a published one keeps its cover. */
  async function coverChange(context: Context, accountId: string, draftId: string, cover: StoredCover | null) {
    const changed = await context.transaction((social) => setDraftCover(social, accountId, draftId, cover), { label: "social.create_cover" });
    if (changed) return changed;
    const row = await read(context, "social.create_read", (db) => readDraft(db, accountId, draftId));
    throw new SocialRouteError(row ? "draft_published" : "not_found");
  }

  /** After the row names its new cover (or none), the replaced object goes; a failure is counted, never the caller's. */
  async function removeReplaced(replaced: StoredCover | null, current: StoredCover | null): Promise<void> {
    if (!replaced || replaced.key === current?.key) return;
    const store = dependencies.coverStore();
    try {
      if (!store) throw new Error("no store");
      await store.remove(replaced.url);
    } catch {
      recordMetric("social.create", { operation: "cover_remove", outcome: "failed" });
    }
  }

  /** The allowlist a save names: the one already attached, or the caller's own upload, read now. */
  async function allowlistFor(context: Context, draft: CreateDraft, stored: CreateAllowlistSummary | null): Promise<CreateAllowlistSummary | null> {
    if (!draft.allowlist_id) return null;
    if (stored?.allowlist_id === draft.allowlist_id) return stored;
    const did = privyDid(context);
    const found = did ? await dependencies.allowlist(draft.allowlist_id, did) : null;
    if (!found) throw new SocialRouteError("allowlist_not_found");
    return found;
  }

  return Object.freeze({
    list: Object.freeze({
      GET: kit.route({ ...account, name: SOCIAL_CREATE_DRAFTS_ROUTE, bucket: "social_read" }, async (context) => {
        const page = parseDraftPage(new URL(context.request.url).searchParams);
        const body = await timed(
          "social.create",
          () => read(context, "social.create_list", (db) => readDraftPage(db, context.account!.account_id, page)),
          { operation: "list" },
          { sampleRate: 0.1 },
        );
        return context.json(body);
      }),
    }),

    draft: Object.freeze({
      GET: kit.route({ ...account, name: SOCIAL_CREATE_DRAFT_READ_ROUTE, bucket: "social_read" }, async (context) => {
        const body = await timed("social.create", async () => respond(await ownedDraft(context, "social.create_read")), { operation: "read" }, { sampleRate: 0.1 });
        return context.json(body);
      }),

      PUT: kit.route({ ...account, name: SOCIAL_CREATE_DRAFT_SAVE_ROUTE, bucket: "social_create" }, async (context) => {
        const draftId = draftIdOf(context.request);
        const body = await readJson(context.request, CREATE_DRAFT_BODY_LIMIT_BYTES);
        exactKeys(body, ["version", "draft"]);
        const version = versionOf(body.version);
        const draft = draftOf(body.draft);
        const accountId = context.account!.account_id;
        const answer = await timed("social.create", async () => {
          const before = version === 0 ? null : await read(context, "social.create_read", (db) => readDraft(db, accountId, draftId));
          const allowlist = await allowlistFor(context, draft, before?.allowlist ?? null);
          const outcome = await context.transaction(
            (social) => saveDraft(social, { accountId, draftId, version, draft, allowlist, limit: dependencies.draftLimit }),
            { label: "social.create_save" },
          );
          if (outcome.kind === "not_found") throw new SocialRouteError("not_found");
          if (outcome.kind === "conflict") {
            if (outcome.stored.publishedPresaleId !== null) throw new SocialRouteError("draft_published");
            // A retry of a save that already landed: the stored draft is this one.
            if (sameDraft(storedDraftOf(outcome.stored.body), draft)) return { status: 200, row: outcome.stored };
            recordMetric("social.create", { operation: "save", outcome: "conflict" });
            throw new SocialRouteError("draft_conflict", { extra: { draft: await respond(outcome.stored) } });
          }
          return { status: version === 0 ? 201 : 200, row: outcome.row };
        }, { operation: version === 0 ? "create" : "save" });
        return context.json(await respond(answer.row), answer.status);
      }),

      DELETE: kit.route({ ...account, name: SOCIAL_CREATE_DRAFT_DELETE_ROUTE, bucket: "social_create" }, async (context) => {
        const draftId = draftIdOf(context.request);
        await timed(
          "social.create",
          () => context.transaction((social) => deleteDraft(social, context.account!.account_id, draftId), { label: "social.create_delete" }),
          { operation: "delete" },
        );
        return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store", "X-Request-ID": context.requestId } });
      }),
    }),

    logo: Object.freeze({
      PUT: kit.route({ ...account, name: SOCIAL_CREATE_DRAFT_LOGO_ROUTE, bucket: "social_create_logo" }, async (context) => {
        const draftId = draftIdOf(context.request);
        const store = dependencies.logoStore();
        if (!store) throw new SocialRouteError("logo_upload_unavailable");
        const declared = context.request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
        const bytes = await readSocialBody(context.request, CREATE_LOGO_MAX_BYTES);
        const accountId = context.account!.account_id;
        if (!(await read(context, "social.create_read", (db) => readDraft(db, accountId, draftId)))) throw new SocialRouteError("not_found");
        const row = await timed("social.create", async () => {
          const sanitized = await sanitizeSquareImage(bytes, declared, CREATE_LOGO_IMAGE);
          if (!sanitized.ok) throw new SocialRouteError("invalid_logo", { extra: { reason: sanitized.reason } });
          const url = await storeSquareImage(store, CREATE_LOGO_FOLDER, sanitized);
          if (!url) throw new SocialRouteError("logo_upload_unavailable");
          return context.transaction((social) => setDraftLogo(social, accountId, draftId, url), { label: "social.create_logo" });
        }, { operation: "logo" });
        if (!row) throw new SocialRouteError("not_found");
        return context.json(await respond(row));
      }),
    }),

    cover: Object.freeze({
      POST: kit.route({ ...account, name: SOCIAL_CREATE_DRAFT_COVER_ROUTE, bucket: "social_create_logo" }, async (context) => {
        const draftId = draftIdOf(context.request);
        const store = dependencies.coverStore();
        if (!store) throw new SocialRouteError("cover_upload_unavailable");
        const upload = await readCoverUpload(context.request);
        const accountId = context.account!.account_id;
        const draft = await read(context, "social.create_read", (db) => readDraft(db, accountId, draftId));
        if (!draft) throw new SocialRouteError("not_found");
        if (draft.publishedPresaleId) throw new SocialRouteError("draft_published");
        const changed = await timed("social.create", async () => {
          const sanitized = await sanitizeSquareImage(upload.bytes, upload.declared, SALE_COVER_IMAGE);
          if (!sanitized.ok) throw new SocialRouteError("invalid_cover", { extra: { reason: sanitized.reason } });
          const cover = await storeCover(store, draftCoverFolder(draftId), sanitized);
          if (!cover) throw new SocialRouteError("cover_upload_unavailable");
          return coverChange(context, accountId, draftId, cover);
        }, { operation: "cover" });
        await removeReplaced(changed.replaced, changed.row.cover);
        return context.json(await respond(changed.row));
      }),
      DELETE: kit.route({ ...account, name: SOCIAL_CREATE_DRAFT_COVER_DELETE_ROUTE, bucket: "social_create_logo" }, async (context) => {
        const draftId = draftIdOf(context.request);
        const accountId = context.account!.account_id;
        const changed = await timed("social.create", () => coverChange(context, accountId, draftId, null), { operation: "cover_delete" });
        await removeReplaced(changed.replaced, null);
        return context.json(await respond(changed.row));
      }),
    }),

    published: Object.freeze({
      POST: kit.route({ ...account, name: SOCIAL_CREATE_DRAFT_PUBLISHED_ROUTE, bucket: "social_create" }, async (context) => {
        const { row, body } = await ownedDraftRequest(context, 1_024);
        exactKeys(body, ["presale_id"]);
        const parsedPresale = z.string().regex(SUI_OBJECT_ID_PATTERN).safeParse(body.presale_id);
        if (!parsedPresale.success) throw new SocialRouteError("invalid_request", { extra: { field: "presale_id" } });
        const presaleId = parsedPresale.data;
        const accountId = context.account!.account_id;
        const holder = await dependencies.editor(presaleId);
        const wallets = holder ? await dependencies.wallets(accountId) : [];
        if (!holder || !wallets.some((wallet) => normalizeSuiAddress(wallet) === normalizeSuiAddress(holder))) {
          throw new SocialRouteError("not_sale_creator");
        }
        const draft = storedDraftOf(row.body);
        // The coin's description (the draft's line) becomes the sale's tagline when it is one by R3-24's rules.
        const line = normalizeSaleTagline(draft.tagline);
        const tagline = line.ok && line.value && (await dependencies.findBlockedTerm(line.value)) === null ? line.value : null;
        const answer = await timed("social.create", () =>
          context.transaction(async (social) => {
            const outcome = await recordDraftPublished(social, accountId, row.draftId, presaleId);
            if (outcome.kind === "not_found") throw new SocialRouteError("not_found");
            if (outcome.kind === "conflict") throw new SocialRouteError("draft_published");
            if (outcome.kind === "already") return readStoredSaleMetadata(social, presaleId);
            // One transaction: the sale record and its details land together, or neither does.
            const recorded = outcome.row;
            const [, site, x_handle, telegram, docs_url, audit_url] = draftDetailColumns(storedDraftOf(recorded.body));
            const change: SaleMetadataChange = { tagline, site: site ?? null, x_handle: x_handle ?? null, telegram: telegram ?? null, docs_url: docs_url ?? null, audit_url: audit_url ?? null, cover: recorded.cover };
            return (await writeSaleMetadata(social, presaleId, change, { accountId })).stored;
          }, { label: "social.create_published" }),
        { operation: "published" });
        const response: SocialSaleMetadataResponse = { presale_id: presaleId, metadata: publicSaleMetadata(answer), editable: true };
        return context.json(response);
      }),
    }),

    publish: Object.freeze({
      POST: kit.route({ ...account, name: SOCIAL_CREATE_DRAFT_PUBLISH_ROUTE, bucket: "social_create" }, async (context) => {
        const { row, body } = await ownedDraftRequest(context, 4 * 1_024);
        if (row.publishedPresaleId !== null) throw new SocialRouteError("draft_published");
        exactKeys(body, ["version", "step", "creator"], ["coin", "fee"]);
        if (body.fee !== undefined && body.fee !== "wallet" && body.fee !== "sponsored") throw new SocialRouteError("invalid_request");
        const draft = storedDraftOf(row.body);
        const availability = publishAvailability({ state: dependencies.deployment(), template: dependencies.template, draft });
        if (!availability.available) {
          recordMetric("social.create", { operation: "publish", outcome: "unavailable", reasons: availability.reasons.join(",") });
          throw new SocialRouteError("publish_unavailable", { extra: { reasons: availability.reasons } });
        }
        if (versionOf(body.version) !== row.version) throw new SocialRouteError("draft_conflict", { extra: { draft: await respond(row) } });
        const creator = addressOf(body.creator);
        if (!(await dependencies.wallets(context.account!.account_id)).includes(creator)) throw new SocialRouteError("invalid_request", { extra: { field: "creator" } });
        const fees = await dependencies.feePolicy();
        const nowMs = now();
        const issues = createIssues(draft, { fees, allowlist: row.allowlist, creator, nowMs });
        if (issues.length > 0) throw new SocialRouteError("draft_incomplete", { extra: { issue_count: issues.length } });
        if (body.step === "publish_coin") {
          const issue = await raiseIssue(draft);
          if (issue) refuseRaise(issue);
        }
        const plan = await timed("social.create", async () => {
          const identity = await dependencies.authorize(draft.venue, context.request.signal);
          if (!mainnetIdentity({ status: "ready", identity })) throw new SocialRouteError("publish_unavailable", { extra: { reasons: ["presale_not_deployed"] } });
          const policy = await dependencies.creationPolicy(identity);
          const witness = normalizeStructTag(`${identity.presale.migrators.originalPackageId}::${draft.venue}::Venue`);
          // R3-42: the chain's CreationPolicy must admit the coin this draft raises (USDC or SUI).
          if (!policy) throw new SocialRouteError("publish_unavailable", { extra: { reasons: ["creation_policy"] } });
          if (!policy.quotes.includes(normalizeStructTag(draft.quote_type))) {
            throw new SocialRouteError("publish_unavailable", { extra: { reasons: ["creation_policy"], contract_error: "EQuoteNotAllowed" } });
          }
          if (!policy.witnesses.includes(witness)) {
            throw new SocialRouteError("publish_unavailable", { extra: { reasons: ["creation_policy"], contract_error: "EMigrationWitnessNotAllowed" } });
          }
          if (draft.venue === "cetus") {
            const supported = await dependencies.cetusTiers();
            const issue = cetusDraftIssue(draft, supported);
            if (issue) throw new SocialRouteError("draft_incomplete", { extra: { issue_count: 1, issues: [issue] } });
          } else {
            const options = await dependencies.bluefinOptions();
            const issue = bluefinDraftIssue(draft, options);
            if (issue) throw new SocialRouteError("draft_incomplete", { extra: { issue_count: 1, issues: [issue] } });
          }
          const args = presaleArgs(draft, { fees, allowlist: row.allowlist, creator, logoUrl: row.logoUrl, nowMs });
          const route = identity.manifest?.routes.find((candidate) => candidate.venue === args.venue);
          if (identity.manifest && !route?.tiers.some(({ tickSpacing, feeRate }) => tickSpacing === args.tickSpacing && feeRate === String(args.poolFeeRate))) {
            throw new SocialRouteError("publish_unavailable", { extra: { reasons: ["creation_policy"] } });
          }
          const stepInput = { identity, args, creator, template: dependencies.template! };
          return {
            ...await stepPlan(body, stepInput, async (coin) => {
              const issue = await raiseIssue(draft);
              if (issue && !(await approvedPublication(context, row, stepInput, coin))) refuseRaise(issue);
            }),
            presale_package: {
              package_id: identity.presale.packageId,
              original_package_id: identity.presale.originalPackageId,
              core_original_package_id: identity.presale.core.originalPackageId,
              venue: args.venue,
              ...(identity.manifest ? { deployment_fingerprint: deploymentFingerprint(identity.manifest) } : {}),
            },
          };
        }, { operation: "publish" });
        const prepared = await preparePublishStep(context, row, creator, body.fee === "sponsored", plan);
        const answer: CreatePublishPlan = { draft_id: row.draftId, version: row.version, steps: [prepared] };
        return context.json(answer);
      }),
    }),
  });
}

function addressOf(value: unknown): string {
  return normalizeSuiAddress(socialInput(z.string().regex(/^0x[0-9a-fA-F]{64}$/), value));
}

function objectIdOf(value: unknown): string {
  return socialInput(z.string().refine((value) => isValidSuiObjectId(value)), value).toLowerCase();
}

function decimalOf(value: unknown): string {
  return socialInput(z.string().regex(/^[1-9][0-9]{0,19}$/), value);
}

function refuseRaise(issue: CreateIssue): never {
  throw new SocialRouteError("draft_incomplete", { extra: { issue_count: 1, issues: [issue], reason: "minimum_raise" } });
}

type StepInput = Readonly<{ identity: PresaleRuntimeIdentity; args: ReturnType<typeof presaleArgs>; creator: string; template: CoinTemplate }>;

async function coinPublishTransaction(input: StepInput): Promise<string> {
  const { modules, dependencies } = await input.template.bytecode(input.args.coin, input.identity.presale);
  const tx = new Transaction();
  const [upgradeCap] = tx.publish({ modules, dependencies });
  tx.moveCall({ target: "0x2::package::make_immutable", arguments: [upgradeCap!] });
  tx.setSenderIfNotSet(input.creator);
  return tx.toJSON();
}

/**
 * One step of the publish plan, by `step`:
 * - `publish_coin`: the coin's own package from the template, with the
 *   draft's name, ticker, line and logo; its `UpgradeCap` is made immutable so
 *   the coin can never change.
 * - `register_currency`: shares the coin's `Currency` (`coin.currency` is the
 *   `Receiving` reference the publish's effects show).
 * - `create_presale`: the venue's `new` and `share`, the cap to the creator.
 */
async function stepPlan(
  body: Record<string, unknown>,
  input: StepInput,
  authorizeRaise: (coin: PublicationCoin) => Promise<void>,
): Promise<CreatePublishPlan["steps"][number]> {
  const rawCoin = body.coin;
  if (body.step === "publish_coin") {
    if (rawCoin !== undefined) throw new SocialRouteError("invalid_request");
    return { kind: "publish_coin", transaction: await coinPublishTransaction(input) };
  }
  const coin = socialInput(z.looseObject({ coin_type: z.string().refine((value) => isValidStructTag(value)), currency: z.unknown().nonoptional() }), rawCoin);
  const currency = socialInput(z.record(z.string(), z.unknown()), coin.currency);
  if (body.step === "register_currency") {
    const tx = registerCurrencyTransaction({
      coinType: coin.coin_type,
      currency: { objectId: objectIdOf(currency.object_id), version: decimalOf(currency.version), digest: String(currency.digest ?? "") },
    });
    tx.setSenderIfNotSet(input.creator);
    return { kind: "register_currency", transaction: await tx.toJSON() };
  }
  if (body.step === "create_presale") {
    const sealedCap = socialInput(z.strictObject({
      object_id: z.string().refine(isValidSuiObjectId),
      version: z.string().regex(/^[1-9][0-9]{0,19}$/),
      digest: z.string().min(1),
    }), coin.sealed_treasury_cap);
    const publicationCoin = {
      coinType: normalizeStructTag(coin.coin_type),
      sealedTreasuryCap: { objectId: objectIdOf(sealedCap.object_id), version: sealedCap.version, digest: sealedCap.digest },
    };
    await authorizeRaise(publicationCoin);
    const tx = createPresaleTransaction({
      identity: input.identity,
      args: input.args,
      creator: input.creator,
      coin: {
        ...publicationCoin,
        currency: { objectId: objectIdOf(currency.object_id), initialSharedVersion: decimalOf(currency.initial_shared_version) },
      },
    });
    tx.setSenderIfNotSet(input.creator);
    return { kind: "create_presale", transaction: await tx.toJSON() };
  }
  throw new SocialRouteError("invalid_request");
}

export type SocialCreateRoutes = ReturnType<typeof createSocialCreateRoutes>;
