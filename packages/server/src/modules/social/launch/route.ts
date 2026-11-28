import { randomBytes } from "node:crypto";

import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import {
  SOCIAL_LAUNCH_COVER_PATH,
  SOCIAL_LAUNCH_LOGO_PATH,
  SOCIAL_LAUNCH_PATH,
  SOCIAL_LAUNCH_PUBLISH_PATH,
  SOCIAL_LAUNCH_PUBLISHED_PATH,
} from "@blast/core/modules/backend-api/private/social-launch-contracts.ts";
import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import { deploymentFingerprint, launchpadDeployment } from "@interest-protocol/blast-sdk/deployments";
import { TransactionDataBuilder, Transaction } from "@mysten/sui/transactions";
import { fromBase64, isValidStructTag, isValidSuiObjectId, normalizeStructTag, normalizeSuiAddress, toHex } from "@mysten/sui/utils";
import { z } from "zod";

import { recordMetric, timed } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { CREATE_DRAFT_ID_PATTERN } from "@blast/core/modules/social/contracts/create.ts";
import {
  LAUNCH_DRAFT_BODY_LIMIT_BYTES,
  LAUNCH_DRAFT_LIMIT,
  LAUNCH_PUBLISH_STEPS,
  SOCIAL_LAUNCH_DRAFT_COVER_DELETE_ROUTE,
  SOCIAL_LAUNCH_DRAFT_COVER_ROUTE,
  SOCIAL_LAUNCH_DRAFT_DELETE_ROUTE,
  SOCIAL_LAUNCH_DRAFT_LOGO_ROUTE,
  SOCIAL_LAUNCH_DRAFT_PUBLISH_ROUTE,
  SOCIAL_LAUNCH_DRAFT_PUBLISHED_ROUTE,
  SOCIAL_LAUNCH_DRAFT_READ_ROUTE,
  SOCIAL_LAUNCH_DRAFT_SAVE_ROUTE,
  SOCIAL_LAUNCH_DRAFTS_ROUTE,
  type LaunchDraftList,
  type LaunchDraftResponse,
  type LaunchPublishCoin,
  type LaunchPublishPlan,
  type LaunchPublishStep,
} from "@blast/core/modules/social/contracts/launch.ts";
import { launchIssues, launchVenueTiers, LaunchDraftShapeError, parseLaunchDraft, parseStoredLaunchDraft, sameLaunchDraft, type LaunchDraft, type LaunchRules, type LaunchVenue } from "@blast/core/modules/social/launch/model.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialBody, type SocialRequestContext, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { sponsorAccountKey, type SponsorCaller } from "@blast/server/modules/sponsor/caller.ts";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";
import type { BlockedTermFinder } from "@blast/server/modules/social/accounts/creation.ts";
import { CREATE_LOGO_FOLDER, CREATE_LOGO_IMAGE } from "@blast/server/modules/social/create/logo.ts";
import type { CreateLogoStore } from "@blast/server/modules/social/create/route.ts";
import { ACCOUNT_COMMITMENT_BYTES } from "@blast/server/modules/social/creator-claims/commitment.ts";
import type { ReadPublishedLaunch } from "@blast/server/modules/social/launch/reconcile.ts";
import { launchStepTransaction } from "@blast/server/modules/social/launch/chain.ts";
import type { MemeTemplate } from "@blast/server/modules/social/launch/meme-template.ts";
import {
  deleteLaunchDraft,
  listLaunchDrafts,
  readLaunchDraft,
  recordLaunchCoin,
  recordLaunchPublished,
  saveLaunchDraft,
  saveLaunchPublication,
  type LaunchCreatorX,
  type LaunchPublication,
  type LaunchStepPlan,
  setLaunchCover,
  setLaunchLogo,
  type LaunchDraftRow,
} from "@blast/server/modules/social/launch/store.ts";
import type { StoredCover } from "@blast/server/modules/social/sales/contracts.ts";
import { SALE_COVER_IMAGE, draftCoverFolder, readCoverUpload, storeCover, type SaleCoverStore } from "@blast/server/modules/social/sales/cover.ts";
import { publicCover } from "@blast/server/modules/social/sales/store.ts";
import { sanitizeSquareImage, storeSquareImage } from "@blast/server/modules/social/square-image.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

export type SocialLaunchRoutesDependencies = Readonly<{
  kit: SocialRouteKit;
  /** What the deployed launchpad fixes now; a failed read is `service_unavailable`. */
  rules: () => Promise<LaunchRules>;
  /** The released mainnet deployment launches are built against, or null before one exists. */
  deployment: () => BlastDeployment | null;
  canPublish: (deployment: BlastDeployment, venue: LaunchVenue) => Promise<boolean>;
  logoStore: () => CreateLogoStore | null;
  coverStore: () => SaleCoverStore | null;
  template: MemeTemplate | null;
  /** The account's wallet addresses (the publishing wallet must be one of them). */
  wallets: (accountId: string) => Promise<readonly string[]>;
  /** The account's creator commitment, minted on first use (LP-16). */
  commitment: (context: SocialRequestContext, accountId: string) => Promise<Uint8Array>;
  /** The launch's Meme type, read from the chain, or null when no such launch exists. */
  launchMemeType: (launchId: string) => Promise<string | null>;
  readPublishedLaunch: ReadPublishedLaunch;
  resolveCreatorX: (handle: string) => Promise<string | null>;
  canAssignCreatorX: (signal: AbortSignal) => Promise<boolean>;
  /** Pins all wallet gas references before any publication plan is returned. */
  preparePublication: (transaction: Transaction) => Promise<Readonly<{ transaction: string; digest: string }>>;
  /** Null while unknown; only a confirmed failure permits replacing pinned bytes. */
  /** `accountKey` is the caller's `sponsorAccountKey`: a sponsored step's reservation is keyed by it. */
  publicationStatus: (publication: LaunchStepPlan, creator: string, accountKey: string | null) => Promise<"failed" | "pending" | "confirmed">;
  /** Effect-derived coin of the stored, successful publication. Never client assertions. */
  publicationCoin: (publication: LaunchPublication) => Promise<LaunchPublishCoin>;
  findBlockedTerm: BlockedTermFinder;
  /** Sponsors only the transaction this route built, after checking the draft and creator. */
  sponsorCreation?: (request: Readonly<{ caller: SponsorCaller; sender: string; transaction: Transaction; ip: string; signal: AbortSignal }>) => Promise<NonNullable<LaunchPublishStep["sponsorship"]>>;
  database?: () => ReadableDatabase;
}>;

type Context = SocialRequestContext;

const LAUNCH_PATHS = [SOCIAL_LAUNCH_PATH, SOCIAL_LAUNCH_LOGO_PATH, SOCIAL_LAUNCH_COVER_PATH, SOCIAL_LAUNCH_PUBLISHED_PATH, SOCIAL_LAUNCH_PUBLISH_PATH] as const;

function draftIdOf(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const id = LAUNCH_PATHS.map((path) => routeSegments(path, pathname)).find((segments) => segments !== null)?.id ?? "";
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
  return socialInput(z.record(z.string(), z.unknown()), value);
}

function exactKeys(body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  socialInput(z.strictObject(Object.fromEntries([
    ...required.map((key) => [key, z.unknown().nonoptional()]),
    ...optional.map((key) => [key, z.unknown().optional()]),
  ])), body);
}

const versionOf = (value: unknown): number => socialInput(z.number().int().min(0).max(2_147_483_647), value);

function draftOf(value: unknown): LaunchDraft {
  try {
    return parseLaunchDraft(value);
  } catch (error) {
    if (error instanceof LaunchDraftShapeError) throw new SocialRouteError("invalid_request", { extra: { field: error.field } });
    throw error;
  }
}

function storedDraftOf(value: unknown, rules: LaunchRules): LaunchDraft {
  try {
    return parseStoredLaunchDraft(value, rules);
  } catch (error) {
    if (error instanceof LaunchDraftShapeError) {
      recordMetric("social.launch", { operation: "read", outcome: "stored_draft_invalid" });
      throw new SocialRouteError("service_unavailable");
    }
    throw error;
  }
}

const objectId = (value: unknown): string => socialInput(z.string().refine((id) => isValidSuiObjectId(id)), value).toLowerCase();
const decimal = (value: unknown): string => socialInput(z.string().regex(/^[1-9][0-9]{0,19}$/), value);
const digest = (value: unknown): string => socialInput(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), value);

/** The earlier steps' coin, exactly as a step needs it, normalized. */
function coinOf(value: unknown, step: (typeof LAUNCH_PUBLISH_STEPS)[number]): LaunchPublishCoin {
  const raw = socialInput(z.record(z.string(), z.unknown()), value);
  const coinType = socialInput(z.string().max(512).refine((type) => isValidStructTag(type)), raw.coin_type);
  const currency = socialInput(z.record(z.string(), z.unknown()), raw.currency);
  if (step === "register_currency") {
    return { coin_type: normalizeStructTag(coinType), currency: { object_id: objectId(currency.object_id), version: decimal(currency.version), digest: digest(currency.digest) } };
  }
  const owned = (value: unknown) => {
    const ref = socialInput(z.record(z.string(), z.unknown()), value);
    return { object_id: objectId(ref.object_id), version: decimal(ref.version), digest: digest(ref.digest) };
  };
  return {
    coin_type: normalizeStructTag(coinType),
    ticket: owned(raw.ticket),
    sealed_treasury_cap: owned(raw.sealed_treasury_cap),
    currency: { object_id: objectId(currency.object_id), initial_shared_version: decimal(currency.initial_shared_version) },
  };
}

/** A coin type in the form the table stores (`0x` + 64 hex digits). */
const storedCoinType = (coinType: string): string => {
  const [address, ...rest] = normalizeStructTag(coinType).split("::");
  return [normalizeSuiAddress(address!), ...rest].join("::");
};

/**
 * The Launch routes (contract in `contracts/launch.ts`): the signed-in
 * account's own drafts only, keyed by the account the kit resolved, every
 * answer `Cache-Control: private, no-store`. Issues are computed from the
 * deployed launchpad's rules on every answer, so the page and the chain agree.
 *
 * A publish step is built from the stored draft, never from the body: the
 * body names only the step, the creating wallet and the objects earlier
 * steps created. The first saved plan pins the recipient. The first buy
 * goes to the creating wallet even when another account receives the fees.
 */
export function createSocialLaunchRoutes(dependencies: SocialLaunchRoutesDependencies) {
  const { kit, database } = dependencies;
  const account = { auth: "account", account: "required", cache: "private" } as const;

  function read<Result>(context: Context, label: string, operation: (db: ReadableDatabase) => Promise<Result>): Promise<Result> {
    return database ? operation(database()) : context.transaction((social) => operation(social), { label });
  }

  async function rules(): Promise<LaunchRules> {
    try {
      return await dependencies.rules();
    } catch {
      recordMetric("social.launch", { operation: "rules", outcome: "unavailable" });
      throw new SocialRouteError("service_unavailable");
    }
  }

  async function respond(row: LaunchDraftRow, known?: LaunchRules): Promise<LaunchDraftResponse> {
    const current = known ?? await rules();
    const draft = storedDraftOf(row.body, current);
    return {
      draft_id: row.draftId,
      version: row.version,
      created_at_ms: row.createdAtMs,
      updated_at_ms: row.updatedAtMs,
      draft,
      logo_url: row.logoUrl,
      publishing: row.publication !== null,
      cover: publicCover(row.cover),
      published_launch_id: row.publishedLaunchId,
      issues: launchIssues(draft, { rules: current, logoUrl: row.logoUrl }),
      rules: current,
    };
  }

  async function ownedDraft(context: Context): Promise<LaunchDraftRow> {
    const row = await read(context, "social.launch_read", (db) => readLaunchDraft(db, context.account!.account_id, draftIdOf(context.request)));
    if (!row) throw new SocialRouteError("not_found");
    return row;
  }

  async function removeReplaced(replaced: StoredCover | null, current: StoredCover | null): Promise<void> {
    if (!replaced || replaced.key === current?.key) return;
    try {
      const store = dependencies.coverStore();
      if (!store) throw new Error("no store");
      await store.remove(replaced.url);
    } catch {
      recordMetric("social.launch", { operation: "cover_remove", outcome: "failed" });
    }
  }

  async function coverChange(context: Context, accountId: string, draftId: string, cover: StoredCover | null) {
    const changed = await context.transaction((social) => setLaunchCover(social, accountId, draftId, cover), { label: "social.launch_cover" });
    if (!changed) throw new SocialRouteError("not_found");
    return changed;
  }

  /** Name, ticker, line and tagline are public on-chain or on the page: none may hold a blocked term. */
  async function assertAllowedText(draft: LaunchDraft): Promise<void> {
    for (const [field, text] of [["name", draft.name], ["symbol", draft.symbol], ["description", draft.description], ["tagline", draft.tagline]] as const) {
      if (text.trim() && (await dependencies.findBlockedTerm(text)) !== null) throw new SocialRouteError("blocked_term", { extra: { field } });
    }
  }

  async function savedPlan(context: Context, row: LaunchDraftRow, creator: string, fee: "wallet" | "sponsored", step: (typeof LAUNCH_PUBLISH_STEPS)[number]) {
    if (!row.publication) return { saved: null, replaces: null };
    if (row.publication.creator !== creator || row.publication.fee !== fee) throw new SocialRouteError("draft_published");
    const saved = row.publication.steps[step];
    if (!saved) return { saved: null, replaces: null };
    const accountKey = context.caller ? sponsorAccountKey(context.caller) : null;
    if (await dependencies.publicationStatus(saved, creator, accountKey) !== "failed") return { saved: saved.plan, replaces: null };
    return { saved: null, replaces: saved.digest };
  }

  async function verifiedCoin(context: Context, row: LaunchDraftRow, step: (typeof LAUNCH_PUBLISH_STEPS)[number], value: unknown): Promise<LaunchPublishCoin | null> {
    if (step === "publish_coin") {
      if (value !== undefined) throw new SocialRouteError("invalid_request");
      if (row.coinType !== null) throw new SocialRouteError("draft_published", { extra: { coin_type: row.coinType } });
      await assertAllowedText(storedDraftOf(row.body, await rules()));
      return null;
    }
    if (!row.publication) throw new SocialRouteError("draft_incomplete");
    const coin = coinOf(value, step);
    const published = await dependencies.publicationCoin(row.publication);
    const sameRef = (expected: typeof published.ticket, supplied: typeof coin.ticket) =>
      expected !== undefined && supplied !== undefined &&
      expected.object_id === supplied.object_id && expected.version === supplied.version && expected.digest === supplied.digest;
    if (storedCoinType(published.coin_type) !== storedCoinType(coin.coin_type) ||
      (step === "register_currency" && (!("version" in published.currency) || !("version" in coin.currency) || !sameRef(published.currency, coin.currency))) ||
      (step === "create_launch" && (!sameRef(published.ticket, coin.ticket) || !sameRef(published.sealed_treasury_cap, coin.sealed_treasury_cap)))) {
      throw new SocialRouteError("invalid_request");
    }
    const recorded = await context.transaction((social) => recordLaunchCoin(social, context.account!.account_id, row.draftId, storedCoinType(coin.coin_type)), { label: "social.launch_coin" });
    if (recorded === "not_found") throw new SocialRouteError("not_found");
    if (recorded === "conflict") throw new SocialRouteError("draft_published", { extra: { coin_type: row.coinType } });
    return coin;
  }

  async function verifyStandardLaunch(coinType: string, publication: LaunchPublication, launchId: string): Promise<void> {
    const memeType = await dependencies.launchMemeType(launchId).catch(() => {
      throw new SocialRouteError("service_unavailable");
    });
    const publishedCoin = await dependencies.publicationCoin(publication);
    if (!memeType || storedCoinType(publishedCoin.coin_type) !== coinType || storedCoinType(memeType) !== coinType) {
      throw new SocialRouteError("not_found");
    }
  }

  async function publicationRecipient(context: Context, row: LaunchDraftRow, handle: string | undefined) {
    if (row.creatorX) return { creatorX: row.creatorX, commitment: toHex(row.creatorX.commitment) };
    if (!handle) {
      const commitment = await dependencies.commitment(context, context.account!.account_id);
      return { creatorX: null, commitment: toHex(commitment) };
    }
    if (!(await dependencies.canAssignCreatorX(context.request.signal))) throw new SocialRouteError("creator_x_unavailable");
    const subject = await dependencies.resolveCreatorX(handle);
    if (subject === null) throw new SocialRouteError("creator_x_not_found");
    const creatorX: LaunchCreatorX = { subject, commitment: randomBytes(ACCOUNT_COMMITMENT_BYTES) };
    return { creatorX, commitment: toHex(creatorX.commitment) };
  }

  async function executablePlan(context: Context, transaction: Transaction, step: (typeof LAUNCH_PUBLISH_STEPS)[number], fee: "wallet" | "sponsored", creator: string): Promise<Readonly<{ step: LaunchPublishStep; digest: string }>> {
    if (fee === "wallet") {
      const pinned = await dependencies.preparePublication(transaction);
      return { step: { kind: step, transaction: pinned.transaction }, digest: pinned.digest };
    }
    // A Privy account and an outside wallet's session alike (owner ruling 2026-11-20).
    if (!context.caller) throw new SocialRouteError("unauthorized");
    if (!dependencies.sponsorCreation) throw new SocialRouteError("service_unavailable");
    const sponsorship = await dependencies.sponsorCreation({ caller: context.caller, sender: creator, transaction, ip: context.client.rateKey, signal: context.request.signal }).catch((error: unknown) => {
      if (error instanceof PresaleRouteError && (error.code === "budget_exceeded" || error.code === "rate_limited")) {
        throw new SocialRouteError("rate_limited", { extra: error.extra, retryAfterSeconds: error.retryAfterSeconds ?? undefined });
      }
      throw error;
    });
    const bytes = fromBase64(sponsorship.transaction_bytes);
    return { step: { kind: step, transaction: await Transaction.from(bytes).toJSON(), sponsorship }, digest: TransactionDataBuilder.getDigestFromBytes(bytes) };
  }

  return Object.freeze({
    list: Object.freeze({
      GET: kit.route({ ...account, name: SOCIAL_LAUNCH_DRAFTS_ROUTE, bucket: "social_read" }, async (context) => {
        const drafts = await timed("social.launch", () => read(context, "social.launch_list", (db) => listLaunchDrafts(db, context.account!.account_id, LAUNCH_DRAFT_LIMIT)), { operation: "list" }, { sampleRate: 0.1 });
        return context.json({ drafts } satisfies LaunchDraftList);
      }),
    }),

    draft: Object.freeze({
      GET: kit.route({ ...account, name: SOCIAL_LAUNCH_DRAFT_READ_ROUTE, bucket: "social_read" }, async (context) => {
        const body = await timed("social.launch", async () => respond(await ownedDraft(context)), { operation: "read" }, { sampleRate: 0.1 });
        return context.json(body);
      }),

      PUT: kit.route({ ...account, name: SOCIAL_LAUNCH_DRAFT_SAVE_ROUTE, bucket: "social_create" }, async (context) => {
        const draftId = draftIdOf(context.request);
        const body = await readJson(context.request, LAUNCH_DRAFT_BODY_LIMIT_BYTES);
        exactKeys(body, ["version", "draft"]);
        const version = versionOf(body.version);
        const draft = draftOf(body.draft);
        const accountId = context.account!.account_id;
        const answer = await timed("social.launch", async () => {
          const outcome = await context.transaction(
            (social) => saveLaunchDraft(social, { accountId, draftId, version, draft, limit: LAUNCH_DRAFT_LIMIT }),
            { label: "social.launch_save" },
          );
          if (outcome.kind === "not_found") throw new SocialRouteError("not_found");
          if (outcome.kind === "conflict") {
            if ((outcome.stored.coinType !== null || outcome.stored.publication !== null)) throw new SocialRouteError("draft_published");
            if (sameLaunchDraft(storedDraftOf(outcome.stored.body, await rules()), draft)) return { status: 200, row: outcome.stored };
            recordMetric("social.launch", { operation: "save", outcome: "conflict" });
            throw new SocialRouteError("draft_conflict", { extra: { draft: await respond(outcome.stored) } });
          }
          return { status: version === 0 ? 201 : 200, row: outcome.row };
        }, { operation: version === 0 ? "create" : "save" });
        return context.json(await respond(answer.row), answer.status);
      }),

      DELETE: kit.route({ ...account, name: SOCIAL_LAUNCH_DRAFT_DELETE_ROUTE, bucket: "social_create" }, async (context) => {
        const draftId = draftIdOf(context.request);
        await timed("social.launch", () => context.transaction((social) => deleteLaunchDraft(social, context.account!.account_id, draftId), { label: "social.launch_delete" }), { operation: "delete" });
        return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store", "X-Request-ID": context.requestId } });
      }),
    }),

    logo: Object.freeze({
      PUT: kit.route({ ...account, name: SOCIAL_LAUNCH_DRAFT_LOGO_ROUTE, bucket: "social_create_logo" }, async (context) => {
        const draftId = draftIdOf(context.request);
        const store = dependencies.logoStore();
        if (!store) throw new SocialRouteError("logo_upload_unavailable");
        const declared = context.request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
        const bytes = await readSocialBody(context.request, CREATE_LOGO_IMAGE.maxBytes);
        const accountId = context.account!.account_id;
        const existing = await read(context, "social.launch_read", (db) => readLaunchDraft(db, accountId, draftId));
        if (!existing) throw new SocialRouteError("not_found");
        if (existing.coinType !== null || existing.publication !== null) throw new SocialRouteError("draft_published");
        const row = await timed("social.launch", async () => {
          const sanitized = await sanitizeSquareImage(bytes, declared, CREATE_LOGO_IMAGE);
          if (!sanitized.ok) throw new SocialRouteError("invalid_logo", { extra: { reason: sanitized.reason } });
          const url = await storeSquareImage(store, CREATE_LOGO_FOLDER, sanitized);
          if (!url) throw new SocialRouteError("logo_upload_unavailable");
          return context.transaction((social) => setLaunchLogo(social, accountId, draftId, url), { label: "social.launch_logo" });
        }, { operation: "logo" });
        if (!row) throw new SocialRouteError("draft_published");
        return context.json(await respond(row));
      }),
    }),

    cover: Object.freeze({
      POST: kit.route({ ...account, name: SOCIAL_LAUNCH_DRAFT_COVER_ROUTE, bucket: "social_create_logo" }, async (context) => {
        const draftId = draftIdOf(context.request);
        const store = dependencies.coverStore();
        if (!store) throw new SocialRouteError("cover_upload_unavailable");
        const upload = await readCoverUpload(context.request);
        const accountId = context.account!.account_id;
        if (!(await read(context, "social.launch_read", (db) => readLaunchDraft(db, accountId, draftId)))) throw new SocialRouteError("not_found");
        const changed = await timed("social.launch", async () => {
          const sanitized = await sanitizeSquareImage(upload.bytes, upload.declared, SALE_COVER_IMAGE);
          if (!sanitized.ok) throw new SocialRouteError("invalid_cover", { extra: { reason: sanitized.reason } });
          const cover = await storeCover(store, draftCoverFolder(draftId), sanitized);
          if (!cover) throw new SocialRouteError("cover_upload_unavailable");
          return coverChange(context, accountId, draftId, cover);
        }, { operation: "cover" });
        await removeReplaced(changed.replaced, changed.row.cover);
        return context.json(await respond(changed.row));
      }),
      DELETE: kit.route({ ...account, name: SOCIAL_LAUNCH_DRAFT_COVER_DELETE_ROUTE, bucket: "social_create_logo" }, async (context) => {
        const draftId = draftIdOf(context.request);
        const changed = await timed("social.launch", () => coverChange(context, context.account!.account_id, draftId, null), { operation: "cover_delete" });
        await removeReplaced(changed.replaced, null);
        return context.json(await respond(changed.row));
      }),
    }),

    published: Object.freeze({
      POST: kit.route({ ...account, name: SOCIAL_LAUNCH_DRAFT_PUBLISHED_ROUTE, bucket: "social_create" }, async (context) => {
        const row = await ownedDraft(context);
        const body = await readJson(context.request, 1_024);
        exactKeys(body, ["launch_id"]);
        const launchId = socialInput(z.string().regex(SUI_OBJECT_ID_PATTERN), body.launch_id);
        if (row.publishedLaunchId === launchId) return context.json(await respond(row));
        if (row.publishedLaunchId !== null) throw new SocialRouteError("draft_published");
        if (row.coinType === null || row.publication === null) throw new SocialRouteError("draft_incomplete", { extra: { issue_count: 1 } });
        if (row.creatorX) {
          const saved = row.publication.steps.create_launch;
          const verified = saved && await dependencies.readPublishedLaunch(saved, context.request.signal);
          if (!verified || verified.launchId !== launchId || storedCoinType(verified.memeType) !== row.coinType) {
            throw new SocialRouteError("not_found");
          }
        } else {
          await verifyStandardLaunch(row.coinType, row.publication, launchId);
        }
        const accountId = context.account!.account_id;
        const outcome = await timed("social.launch", () => context.transaction((social) => recordLaunchPublished(social, accountId, row.draftId, launchId), { label: "social.launch_published" }), { operation: "published" });
        if (outcome.kind === "not_found") throw new SocialRouteError("not_found");
        if (outcome.kind === "conflict") throw new SocialRouteError("draft_published");
        return context.json(await respond(outcome.row));
      }),
    }),

    publish: Object.freeze({
      POST: kit.route({ ...account, name: SOCIAL_LAUNCH_DRAFT_PUBLISH_ROUTE, bucket: "social_create" }, async (context) => {
        const row = await ownedDraft(context);
        if (row.publishedLaunchId !== null) throw new SocialRouteError("draft_published");
        const body = await readJson(context.request, 4 * 1_024);
        exactKeys(body, ["version", "step", "creator"], ["coin", "fee"]);
        const step = socialInput(z.enum(LAUNCH_PUBLISH_STEPS), body.step);
        const fee = socialInput(z.enum(["wallet", "sponsored"]).optional(), body.fee) ?? "wallet";
        if (versionOf(body.version) !== row.version) throw new SocialRouteError("draft_conflict", { extra: { draft: await respond(row) } });
        const deployment = dependencies.deployment();
        if (!deployment || !dependencies.template) throw new SocialRouteError("publish_unavailable", { extra: { reasons: [deployment ? "template_unavailable" : "launchpad_not_deployed"] } });
        const accountId = context.account!.account_id;
        const creator = normalizeSuiAddress(socialInput(z.string().regex(/^0x[0-9a-fA-F]{64}$/), body.creator));
        if (!(await dependencies.wallets(accountId)).map((wallet) => normalizeSuiAddress(wallet)).includes(creator)) throw new SocialRouteError("invalid_request", { extra: { field: "creator" } });
        const current = await rules();
        const draft = storedDraftOf(row.body, current);
        const tier = launchVenueTiers(current, draft.venue, draft.quote_type).find(([, fee]) => fee === draft.pool_fee);
        const route = deployment.routes.find((candidate) => candidate.venue === draft.venue);
        if (!tier || !route?.tiers.some(({ tickSpacing, feeRate }) => tickSpacing === tier[0] && feeRate === String(tier[1]))) {
          throw new SocialRouteError("publish_unavailable", { extra: { reasons: ["venue_not_admitted"] } });
        }
        if (!(await dependencies.canPublish(deployment, draft.venue))) {
          throw new SocialRouteError("publish_unavailable", { extra: { reasons: ["launch_config"] } });
        }
        const fingerprint = deploymentFingerprint(deployment);
        const retained = await savedPlan(context, row, creator, fee, step);
        if (retained.saved) {
          if (retained.saved.deployment_fingerprint !== fingerprint ||
            retained.saved.core_original_package_id !== deployment.packages.core.originalPackageId ||
            retained.saved.launchpad_original_package_id !== deployment.packages.launchpad.originalPackageId) {
            throw new SocialRouteError("publish_unavailable", { extra: { reasons: ["launchpad_not_deployed"] } });
          }
          return context.json(retained.saved);
        }
        const issues = launchIssues(draft, { rules: current, logoUrl: row.logoUrl });
        if (issues.length > 0) throw new SocialRouteError("draft_incomplete", { extra: { issue_count: issues.length } });
        const coin = await verifiedCoin(context, row, step, body.coin);
        const recipient = step === "publish_coin" ? await publicationRecipient(context, row, draft.creator_x_handle) : null;
        const transaction = await launchStepTransaction({ step, deployment, draft, rules: current, logoUrl: row.logoUrl!, creator,
          accountCommitment: recipient?.commitment ?? null, template: dependencies.template, coin, sponsored: fee === "sponsored" });
        const executable = await executablePlan(context, transaction, step, fee, creator);
        const plan: LaunchPublishPlan = { draft_id: row.draftId, version: row.version,
          deployment_fingerprint: fingerprint,
          launchpad_original_package_id: launchpadDeployment(deployment).originalPackageId,
          core_original_package_id: deployment.packages.core.originalPackageId, steps: [executable.step] };
        const persisted = await context.transaction((social) => saveLaunchPublication(social, accountId, row.draftId, row.version, creator, fee, step, { digest: executable.digest, plan }, retained.replaces, recipient?.creatorX ?? null), { label: "social.launch_publication" });
        if (persisted.plan.deployment_fingerprint !== fingerprint) {
          throw new SocialRouteError("publish_unavailable", { extra: { reasons: ["launchpad_not_deployed"] } });
        }
        return context.json(persisted.plan);
      }),
    }),
  });
}

export type SocialLaunchRoutes = ReturnType<typeof createSocialLaunchRoutes>;
