import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { accountSettingsSchema } from "../src/modules/presale/contracts/account-settings.ts";
import {
  allowlistBindRequestSchema,
  allowlistCreateRequestSchema,
} from "../src/modules/presale/contracts/allowlist-request.ts";
import { bridgeTransferRequestSchema } from "../src/modules/presale/contracts/bridge-transfer-request.ts";
import { executeRequestSchema } from "../src/modules/presale/contracts/execute-request.ts";
import { outcomeRequestSchema } from "../src/modules/presale/contracts/outcome-request.ts";
import {
  sponsorRequestSchema,
  sponsorIntentSchema,
} from "../src/modules/presale/contracts/sponsor-request.ts";
import {
  addressSchema,
  base64Schema,
  digestSchema,
  coinTypeSchema,
  uintSchema,
} from "../src/modules/presale/contracts/primitives.ts";
import { socialErrorSchema } from "../src/modules/social/contracts/errors.ts";
import {
  onboardingShownSchemaMetadata,
  socialOnboardingCompleteRequestSchema,
  socialOnboardingCompleteResponseSchema,
  socialOnboardingShownResponseSchema,
} from "../src/modules/social/contracts/onboarding.ts";
import { portfolioBasisCompleteSchema, portfolioBasisUsdSchema, portfolioHistorySchemaMetadata, portfolioPnlMultipleSchema, portfolioPnlUsdSchema, portfolioSchemaMetadata, socialPortfolioHistorySchema, socialPortfolioSchema } from "../src/modules/social/contracts/portfolio.ts";
import { pricesSchemaMetadata, pricesSchemaReferences, socialPublishedPricesResponseSchema } from "../src/modules/social/contracts/prices.ts";
import { rewardsSchemaMetadata, socialRewardsPageSchema } from "../src/modules/social/contracts/rewards.ts";
import { searchSchemaMetadata, searchSchemaReferences, socialSearchResponseSchema } from "../src/modules/social/contracts/search.ts";
import { socialPublishedTransactionsPageSchema, transactionsSchemaMetadata } from "../src/modules/social/contracts/transactions.ts";
import { socialSettingsRequestSchema, socialSettingsResponseSchema } from "../src/modules/social/contracts/settings.ts";
import {
  socialWalletSessionRequestSchema,
  socialWalletSessionSchema,
  socialWalletSignInChallengeRequestSchema,
  socialWalletSignInChallengeSchema,
  socialWalletSignOutSchema,
} from "../src/modules/social/contracts/wallet-sign-in.ts";
import {
  socialWalletChallengeRequestSchema,
  socialWalletChallengeSchema,
  socialWalletLinkRequestSchema,
  socialWalletLinkedSchema,
} from "../src/modules/social/contracts/wallets.ts";
import { socialBuyAlertResponseSchema, socialFollowingWalletsSchema } from "../src/modules/social/contracts/buy-alerts.ts";
import { socialWatchlistIdsSchema, socialWatchlistKeysSchema } from "../src/modules/social/contracts/watchlist.ts";
import {
  socialWhyCreateRequestSchema,
  socialWhyCreatedSchema,
  socialWhyReportedSchema,
  socialWhyReportRequestSchema,
} from "../src/modules/social/contracts/whys.ts";

import {
  socialCallsignAvailabilitySchema,
  socialCreateAccountRequestSchema,
} from "../src/modules/social/contracts/accounts.ts";
import {
  activityPageDefinitions,
  socialActivityPageSchema,
} from "../src/modules/social/contracts/activity.ts";
import {
  blastWorkspaceAcknowledgementSchema,
  blastWorkspaceRequestSchema,
  blastWorkspaceResponseSchema,
  blastWorkspaceSetupSchema,
} from "../src/modules/social/contracts/blast-workspace.ts";
import {
  socialBridgeWithdrawQuoteSchema,
  socialBridgeWithdrawRequestSchema,
  socialBridgeWithdrawalSchema,
} from "../src/modules/social/contracts/bridge-withdraw.ts";
import {
  createDraftPageSchema,
  createDraftRequestSchema,
  createDraftResponseSchema,
  createDraftSchema,
  createRecipientSchema,
  createPublishPlanSchema,
} from "../src/modules/social/contracts/create.ts";
import {
  socialDepositBridgeSchema,
  socialDepositRequestSchema,
  socialDepositSchema,
} from "../src/modules/social/contracts/deposits.ts";
import {
  socialFeedNewResponseSchema,
  socialFeedPageSchema,
} from "../src/modules/social/contracts/feed.ts";
import {
  homeAmountSchema,
  homePublishedContracts,
} from "../src/modules/social/contracts/home-schemas.ts";
import {
  socialIntentRecordedSchema,
  socialIntentRequestSchema,
} from "../src/modules/social/contracts/intents.ts";
import {
  socialItemResponseSchema,
} from "../src/modules/social/contracts/item-routes.ts";
import {
  feedItemDefinitions,
  socialAsOfSchema,
  socialFeedItemSchema,
} from "../src/modules/social/contracts/items.ts";
import {
  meResponseSchemaMetadata,
  socialMeResponseSchema,
} from "../src/modules/social/contracts/me.ts";
import {
  socialNotificationPageSchema,
  socialNotificationUnreadSchema,
} from "../src/modules/social/contracts/notifications.ts";
import {
  pnlAssetSchema,
  pnlFiguresSchema,
  pnlSchemaDefinitions,
  socialPnlSchema,
} from "../src/modules/social/contracts/pnl.ts";
import {
  socialProfileCallsSchema,
  socialProfileEditRequestSchema,
  socialProfileEditSchema,
  socialProfileMutualsSchema,
} from "../src/modules/social/contracts/profile-page.ts";
import {
  socialProfileItemsPageSchema,
  socialProfileSchema,
} from "../src/modules/social/contracts/profiles.ts";
import {
  saleMetadataRequestSchema,
  socialSaleCoverSourceSchema,
  socialSaleMetadataResponseSchema,
  socialSaleMetadataSchema,
} from "../src/modules/social/contracts/sales.ts";
import {
  socialViewerStateRequestSchema,
  socialViewerStateResponseSchema,
} from "../src/modules/social/contracts/viewer-state.ts";
import { socialMePresalesSchema } from "../src/modules/social/contracts/me-presales.ts";
import {
  socialPresaleDetailSchema,
  socialPresaleListPageSchema,
  socialPresaleSummarySchema,
  socialPresaleViewerRequestSchema,
  socialPresaleViewerResponseSchema,
} from "../src/modules/social/contracts/presale-schemas.ts";
import { socialWatchlistPageSchema } from "../src/modules/social/contracts/watchlist.ts";
import { financialContracts, financialContractOverride } from "./financial-contract-schemas.ts";

const presaleRoot = new URL("../src/modules/presale/contracts/schemas/", import.meta.url);
const socialRoot = new URL("../src/modules/social/contracts/schemas/", import.meta.url);
const definitions = {
  address: addressSchema,
  digest: digestSchema,
  base64: base64Schema,
  coin_type: coinTypeSchema,
  uint: uintSchema,
};
const refs = new Map<z.core.$ZodType, string>(
  Object.entries(definitions).map(([name, schema]) => [schema, `defs.schema.json#/$defs/${name}`]),
);

function publish(root: URL, name: string, schema: object): void {
  const path = new URL(`${name}.schema.json`, root);
  const previous = readExisting(path);
  const previousSchema: unknown = previous === undefined ? undefined : JSON.parse(previous);
  const ordered = publishedOrder(schema, previousSchema);
  // Some published documents use compact whitespace. Retain it when every
  // generated property and constraint matches the document already on disk.
  const generated = previous !== undefined && isDeepStrictEqual(ordered, previousSchema)
    ? previous
    : `${JSON.stringify(ordered, null, 2)}\n`;
  publishFile(path, name, generated, previous);
}

function readExisting(path: URL): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function publishFile(path: URL, name: string, generated: string, previous: string | undefined): void {
  if (process.argv.includes("--check")) {
    assert.equal(
      previous,
      generated,
      `Run npm run contracts:generate -w @blast/core (${name})`,
    );
  } else {
    writeFileSync(path, generated);
  }
}

// Preserve equivalent representations used by existing partner documents. An
// unmatched constraint remains in the generated output and fails --check.
function publishedOrder(value: unknown, previous: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      publishedOrder(item, Array.isArray(previous) ? previous[index] : undefined),
    );
  }
  if (!isRecord(value)) return value;
  const old = isRecord(previous) ? previous : {};
  const record = { ...value };
  if (isRecord(previous)) {
    matchPublishedUnion(record, old);
    matchPublishedKeywords(record, old);
    matchPublishedConstraints(record, old);
  }
  const keys = [...new Set([...Object.keys(old), ...Object.keys(record)])];
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(record, key))
      .map((key) => [key, publishedChild(key, record[key], old[key])]),
  );
}

function publishedChild(keyword: string, value: unknown, previous: unknown): unknown {
  if (["$defs", "properties", "patternProperties", "dependentSchemas"].includes(keyword) && isRecord(value)) {
    const old = isRecord(previous) ? previous : {};
    const keys = [...new Set([...Object.keys(old), ...Object.keys(value)])];
    return Object.fromEntries(
      keys
        .filter((key) => Object.hasOwn(value, key))
        .map((key) => [key, publishedOrder(value[key], old[key])]),
    );
  }
  if (["allOf", "anyOf", "oneOf", "prefixItems", "not", "if", "then", "else", "items",
    "additionalProperties", "unevaluatedProperties", "propertyNames", "contains"].includes(keyword)) {
    return publishedOrder(value, previous);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchPublishedKeywords(schema: Record<string, unknown>, previous: Record<string, unknown>): void {
  for (const annotation of ["description", "readOnly"]) {
    if (!Object.hasOwn(previous, annotation)) delete schema[annotation];
  }
  for (const keyword of ["required", "enum"]) {
    const old = previous[keyword];
    const next = schema[keyword];
    if (Array.isArray(old) && Array.isArray(next) &&
        old.length === next.length && old.every((entry) => next.includes(entry))) {
      schema[keyword] = old;
    }
  }

  matchPublishedLiteralType(schema, previous);
}

function matchPublishedLiteralType(schema: Record<string, unknown>, previous: Record<string, unknown>): void {
  const literals = Array.isArray(schema.enum) ? schema.enum : [schema.const];
  const literalType = previous.type ?? schema.type;
  const matches = literals.every((value) => {
    if (literalType === "integer") return typeof value === "number" && Number.isInteger(value);
    if (literalType === "null") return value === null;
    return typeof value === literalType;
  });
  if (!matches) return;
  if (previous.type === undefined) delete schema.type;
  else if (schema.type === undefined) schema.type = previous.type;
}

function matchPublishedConstraints(schema: Record<string, unknown>, previous: Record<string, unknown>): void {
  if (typeof schema.pattern === "string" && typeof previous.pattern === "string" &&
      unescapeRegexDelimiter(schema.pattern) === unescapeRegexDelimiter(previous.pattern)) {
    schema.pattern = previous.pattern;
  }
  if (schema.type === "integer" && schema.exclusiveMinimum === 0 && previous.minimum === 1) {
    delete schema.exclusiveMinimum;
    schema.minimum = 1;
  }
  matchPublishedTuple(schema, previous);
  if (isDeepStrictEqual(schema.propertyNames, { type: "string" }) && previous.propertyNames === undefined) {
    delete schema.propertyNames;
  }
}

// RegExp.source escapes the literal delimiter, including inside character classes.
function unescapeRegexDelimiter(pattern: string): string {
  return pattern.replace(/(?<!\\)((?:\\\\)*)\\\//g, "$1/");
}

function matchPublishedTuple(schema: Record<string, unknown>, previous: Record<string, unknown>): void {
  if (schema.items !== false || !Array.isArray(schema.prefixItems)) return;
  if (schema.maxItems === schema.prefixItems.length && previous.maxItems === undefined) {
    delete schema.maxItems;
  }
  if (typeof schema.maxItems === "number" && schema.maxItems <= schema.prefixItems.length &&
      previous.items === undefined) {
    delete schema.items;
  }
}

function matchPublishedUnion(schema: Record<string, unknown>, previous: Record<string, unknown>): void {
  const publishedKeyword = Array.isArray(previous.oneOf) ? "oneOf" : "anyOf";
  const publishedBranches = previous[publishedKeyword];
  if (Array.isArray(schema.type) && Array.isArray(publishedBranches) &&
      Object.keys(schema).every((key) => ["type", "description", "readOnly"].includes(key))) {
    schema[publishedKeyword] = schema.type.map((type) => ({ type }));
    delete schema.type;
  }

  const keyword = Array.isArray(schema.oneOf) ? "oneOf" : "anyOf";
  const branches = schema[keyword];
  if (!Array.isArray(branches) || branches.length !== 2 || !branches.every(isRecord)) return;
  const nullBranch = branches.find(isNullSchema);
  if (!nullBranch) return;
  const other = branches.find((branch) => branch !== nullBranch)!;

  if (Array.isArray(previous.enum) && Array.isArray(other.enum) && !other.enum.includes(null) &&
      Object.keys(other).every((key) => key === "enum" || key === "type")) {
    delete schema[keyword];
    schema.enum = [...other.enum, null];
    return;
  }

  if (typeof other.type !== "string" || other.type === "null") return;
  if (Array.isArray(previous.type) && previous.type.length === 2 &&
      previous.type.includes("null") && previous.type.includes(other.type)) {
    delete schema[keyword];
    Object.assign(schema, other, { type: previous.type });
    return;
  }
  if (Array.isArray(publishedBranches) && publishedBranches.length === 2 && publishedBranches.some(isNullSchema)) {
    delete schema[keyword];
    schema[publishedKeyword] = isNullSchema(publishedBranches[0]) ? [nullBranch, other] : [other, nullBranch];
  }
}

function isNullSchema(value: unknown): boolean {
  return isDeepStrictEqual(value, { type: "null" });
}

for (const [name, schema] of [
  ["account-settings-request", accountSettingsSchema],
  ["allowlist-bind-request", allowlistBindRequestSchema],
  ["allowlist-create-request", allowlistCreateRequestSchema],
  ["bridge-transfer-request", bridgeTransferRequestSchema],
  ["execute-request", executeRequestSchema],
  ["outcome-request", outcomeRequestSchema],
  ["sponsor-request", sponsorRequestSchema],
] as const) {
  publish(
    presaleRoot,
    name,
    z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io: "input",
      override: ({ zodSchema, jsonSchema }) => {
        // The published contract uses if/then/else for this union. Derive the
        // equivalent layout from the Zod branches while retaining that format.
        if (zodSchema === sponsorRequestSchema) {
          const branches = jsonSchema.anyOf as Array<{ properties: Record<string, unknown> }>;
          delete jsonSchema.anyOf;
          Object.assign(jsonSchema, {
            type: "object",
            properties: {
              ...branches[0].properties,
              intent: { enum: sponsorIntentSchema.options },
            },
            required: ["sender", "transaction_kind_bytes", "intent"],
            if: { properties: { intent: { const: "withdraw" } } },
            then: { properties: { presale_id: false } },
            else: {
              properties: { presale_id: branches[0].properties.presale_id },
              required: ["presale_id"],
            },
            additionalProperties: false,
          });
        }
        const ref = refs.get(zodSchema);
        if (ref) {
          for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
          jsonSchema.$ref = ref;
        }
        // Keep the published enum layout and references byte-for-byte compatible.
        if (jsonSchema.enum && jsonSchema.type === "string") delete jsonSchema.type;
      },
    }),
  );
}

// The remaining shared definitions stay hand-authored until their boundaries migrate.
const shared = JSON.parse(readFileSync(new URL("defs.schema.json", presaleRoot), "utf8"));
for (const [name, schema] of Object.entries(definitions)) {
  const { $schema, ...definition } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  });
  void $schema;
  shared.$defs[name] = definition;
}
publish(presaleRoot, "defs", shared);

const socialContracts = {
  "watchlist-page": socialWatchlistPageSchema,
  "presale-viewer-response": socialPresaleViewerResponseSchema,
  "presale-viewer-request": socialPresaleViewerRequestSchema,
  "presale-summary": socialPresaleSummarySchema,
  "presale-list-page": socialPresaleListPageSchema,
  "presale-detail": socialPresaleDetailSchema,
  "me-presales-response": socialMePresalesSchema,
  "create-publish-plan": createPublishPlanSchema,
  ...financialContracts,
  "account-create-request": socialCreateAccountRequestSchema,
  "activity-page": socialActivityPageSchema,
  "blast-workspace-acknowledgement": blastWorkspaceAcknowledgementSchema,
  "blast-workspace-request": blastWorkspaceRequestSchema,
  "blast-workspace-response": blastWorkspaceResponseSchema,
  "blast-workspace-setup": blastWorkspaceSetupSchema,
  "bridge-withdraw-quote-response": socialBridgeWithdrawQuoteSchema,
  "bridge-withdraw-request": socialBridgeWithdrawRequestSchema,
  "bridge-withdraw-response": socialBridgeWithdrawalSchema,
  "callsign-availability-response": socialCallsignAvailabilitySchema,
  "create-draft": createDraftSchema,
  "create-draft-page": createDraftPageSchema,
  "create-draft-request": createDraftRequestSchema,
  "create-draft-response": createDraftResponseSchema,
  "deposit-bridge-response": socialDepositBridgeSchema,
  "deposit-request": socialDepositRequestSchema,
  "deposit-response": socialDepositSchema,
  "feed-item": socialFeedItemSchema,
  "feed-new-response": socialFeedNewResponseSchema,
  "feed-page": socialFeedPageSchema,
  "intent-request": socialIntentRequestSchema,
  "intent-response": socialIntentRecordedSchema,
  "item-response": socialItemResponseSchema,
  "me-response": socialMeResponseSchema,
  "notification-page": socialNotificationPageSchema,
  "pnl-response": socialPnlSchema,
  "profile-calls-response": socialProfileCallsSchema,
  "profile-edit-request": socialProfileEditRequestSchema,
  "profile-edit-response": socialProfileEditSchema,
  "profile-items-page": socialProfileItemsPageSchema,
  "profile-mutuals-response": socialProfileMutualsSchema,
  "profile-response": socialProfileSchema,
  "sale-metadata": socialSaleMetadataSchema,
  "sale-metadata-request": saleMetadataRequestSchema,
  "sale-metadata-response": socialSaleMetadataResponseSchema,
  "viewer-state-response": socialViewerStateResponseSchema,
  "as-of": socialAsOfSchema,
  "error": socialErrorSchema,
  "notification-unread-response": socialNotificationUnreadSchema,
  "onboarding-complete-request": socialOnboardingCompleteRequestSchema,
  "onboarding-complete-response": socialOnboardingCompleteResponseSchema,
  "onboarding-shown-response": socialOnboardingShownResponseSchema,
  "portfolio-history-response": socialPortfolioHistorySchema,
  "portfolio-response": socialPortfolioSchema,
  "prices-response": socialPublishedPricesResponseSchema,
  "rewards-page": socialRewardsPageSchema,
  "search-response": socialSearchResponseSchema,
  "transactions-page": socialPublishedTransactionsPageSchema,
  "settings-request": socialSettingsRequestSchema,
  "settings-response": socialSettingsResponseSchema,
  "viewer-state-request": socialViewerStateRequestSchema,
  "wallet-challenge-request": socialWalletChallengeRequestSchema,
  "wallet-challenge-response": socialWalletChallengeSchema,
  "wallet-link-request": socialWalletLinkRequestSchema,
  "wallet-link-response": socialWalletLinkedSchema,
  "wallet-session-request": socialWalletSessionRequestSchema,
  "wallet-session-response": socialWalletSessionSchema,
  "wallet-sign-in-challenge-request": socialWalletSignInChallengeRequestSchema,
  "wallet-sign-in-challenge-response": socialWalletSignInChallengeSchema,
  "wallet-sign-out-response": socialWalletSignOutSchema,
  "watchlist-ids-response": socialWatchlistIdsSchema,
  "buy-alert-response": socialBuyAlertResponseSchema,
  "following-wallets-response": socialFollowingWalletsSchema,
  "watchlist-keys-response": socialWatchlistKeysSchema,
  "why-request": socialWhyCreateRequestSchema,
  "why-response": socialWhyCreatedSchema,
  "why-report-request": socialWhyReportRequestSchema,
  "why-report-response": socialWhyReportedSchema,
};

type SocialPublication = {
  definitions?: Record<string, z.ZodType>;
  references?: ReadonlyMap<z.core.$ZodType, string>;
  metadata?: z.core.$ZodRegistry<z.core.JSONSchemaMeta>;
  override?: NonNullable<Parameters<typeof z.toJSONSchema>[1]>["override"];
};

function contractRef(name: string, fragment = ""): string {
  return `https://blast-v2.invalid/social/contracts/${name}.schema.json${fragment}`;
}

const asOfReference = [socialAsOfSchema, contractRef("as-of")] as const;
const feedItemReference = [socialFeedItemSchema, contractRef("feed-item")] as const;
const feedDefinitions = Object.entries(feedItemDefinitions).map(
  ([name, schema]) => [schema, contractRef("feed-item", `#/$defs/${name}`)] as const,
);
const feedReferences = new Map<z.core.$ZodType, string>([
  asOfReference, feedItemReference, ...feedDefinitions,
]);
const feedPageReferences = new Map<z.core.$ZodType, string>([asOfReference, feedItemReference]);
const createDraftReference = [createDraftSchema, "create-draft.schema.json"] as const;
const presaleSummaryReference = [socialPresaleSummarySchema, contractRef("presale-summary")] as const;
const saleMetadataReference = [socialSaleMetadataSchema, contractRef("sale-metadata")] as const;
const homeReferences = new Map<z.core.$ZodType, string>([
  ...feedReferences,
  [homeAmountSchema, contractRef("home-thread-page", "#/$defs/amount")],
  [portfolioBasisUsdSchema, contractRef("portfolio-response", "#/$defs/basis_usd")],
  [portfolioBasisCompleteSchema, contractRef("portfolio-response", "#/$defs/basis_complete")],
  [portfolioPnlUsdSchema, contractRef("portfolio-response", "#/$defs/pnl_usd")],
  [portfolioPnlMultipleSchema, contractRef("portfolio-response", "#/$defs/pnl_multiple")],
  [socialSaleMetadataSchema.shape.cover, contractRef("sale-metadata", "#/properties/cover")],
]);
const happeningReferences = new Map<z.core.$ZodType, string>([
  ...homeReferences,
  [homePublishedContracts["happening-response"].schema.shape.clock_ms, contractRef("feed-item", "#/$defs/millis")],
]);
const workspaceReferences = new Map<z.core.$ZodType, string>([
  [blastWorkspaceSetupSchema, contractRef("blast-workspace-setup")],
]);

const socialPublications: Partial<Record<keyof typeof socialContracts, SocialPublication>> = {
  "activity-page": { definitions: activityPageDefinitions, references: feedReferences },
  "blast-workspace-request": { references: workspaceReferences },
  "buy-alert-response": { references: feedReferences },
  "blast-workspace-response": { references: workspaceReferences },
  "create-draft": { definitions: { vestingRecipient: createRecipientSchema } },
  "create-draft-request": { references: new Map([createDraftReference]) },
  "create-draft-response": {
    references: new Map<z.core.$ZodType, string>([
      createDraftReference,
      [socialSaleCoverSourceSchema, contractRef("sale-metadata", "#/properties/cover/oneOf/1/properties/source")],
    ]),
  },
  "feed-item": { definitions: feedItemDefinitions },
  "feed-new-response": { references: new Map([asOfReference]) },
  "feed-page": { references: feedPageReferences },
  "item-response": { references: feedPageReferences },
  "me-response": { metadata: meResponseSchemaMetadata },
  "me-presales-response": {
    override: ({ zodSchema, jsonSchema }) => {
      if (Object.is(zodSchema, socialMePresalesSchema)) {
        const created = jsonSchema.properties?.created;
        if (typeof created === "object") created.items = { $ref: "#/properties/watchlist/items" };
      }
    },
  },
  "presale-detail": { references: new Map([...feedPageReferences, saleMetadataReference]) },
  "presale-list-page": { references: new Map<z.core.$ZodType, string>([asOfReference, presaleSummaryReference]) },
  "presale-summary": { references: new Map([saleMetadataReference]) },
  "presale-viewer-response": {
    references: new Map([presaleSummaryReference]),
    override: ({ jsonSchema }) => {
      const propertyNames = jsonSchema.propertyNames;
      if (typeof propertyNames === "object" && propertyNames.pattern) {
        delete propertyNames.type;
      }
    },
  },
  "watchlist-page": { references: new Map<z.core.$ZodType, string>([asOfReference, presaleSummaryReference]) },
  "pnl-response": { definitions: pnlSchemaDefinitions, override: renderPublishedPnl },
  "profile-calls-response": { references: new Map([asOfReference]) },
  "profile-items-page": { references: feedPageReferences },
  "profile-response": { references: new Map([asOfReference]) },
  "sale-metadata-response": { references: new Map([saleMetadataReference]) },
  "viewer-state-response": {
    references: new Map([[feedItemDefinitions.backer, contractRef("feed-item", "#/$defs/backer")]]),
    override: ({ jsonSchema }) => {
      const propertyNames = jsonSchema.propertyNames;
      if (typeof propertyNames === "object" && propertyNames.pattern) {
        delete propertyNames.type;
      }
    },
  },
  "onboarding-shown-response": { metadata: onboardingShownSchemaMetadata },
  "portfolio-history-response": { metadata: portfolioHistorySchemaMetadata },
  "portfolio-response": { metadata: portfolioSchemaMetadata },
  "prices-response": { metadata: pricesSchemaMetadata, references: pricesSchemaReferences },
  "rewards-page": { metadata: rewardsSchemaMetadata },
  "search-response": { metadata: searchSchemaMetadata, references: searchSchemaReferences },
  "transactions-page": { metadata: transactionsSchemaMetadata },
};

function renderPublishedPnl({ zodSchema, jsonSchema }: {
  zodSchema: z.core.$ZodType;
  jsonSchema: z.core.JSONSchema.BaseSchema;
}): void {
  if (Object.is(zodSchema, pnlAssetSchema)) {
    const figureFields = Object.keys(pnlFiguresSchema.shape);
    for (const field of figureFields) {
      delete jsonSchema.properties?.[field];
    }
    jsonSchema.required = jsonSchema.required?.filter((key) => !figureFields.includes(key));
    delete jsonSchema.additionalProperties;
    jsonSchema.allOf = [{ $ref: "#/$defs/figures" }];
    jsonSchema.unevaluatedProperties = false;
  }
  if (Object.is(zodSchema, pnlFiguresSchema)) {
    delete jsonSchema.additionalProperties;
  }
  if (Object.is(zodSchema, socialPnlSchema)) {
    jsonSchema.properties!.totals = {
      type: "object", $ref: "#/$defs/figures", unevaluatedProperties: false,
    };
  }
}

function socialDocument(
  name: string,
  schema: z.ZodType,
  { definitions, references, metadata, override }: SocialPublication = {},
): object {
  const referencesBySchema = new Map(references);
  for (const [key, definition] of Object.entries(definitions ?? {})) {
    referencesBySchema.set(definition, `#/$defs/${key}`);
  }

  function render(root: z.ZodType) {
    return z.toJSONSchema(root, {
      target: "draft-2020-12",
      io: "input",
      metadata,
      override: (context) => {
        const { zodSchema, jsonSchema } = context;
        override?.(context);
        const additional = jsonSchema.additionalProperties;
        if (additional === true || (additional && Object.keys(additional).length === 0)) {
          delete jsonSchema.additionalProperties;
        }

        if (Object.is(zodSchema, root)) {
          return;
        }
        let original: z.core.$ZodType = zodSchema;
        while (original._zod.parent?._zod.def === original._zod.def) {
          original = original._zod.parent;
        }
        const reference = referencesBySchema.get(zodSchema) ?? referencesBySchema.get(original);
        if (reference === undefined) {
          return;
        }
        const description = jsonSchema.description;
        for (const key of Object.keys(jsonSchema)) {
          delete jsonSchema[key];
        }
        jsonSchema.$ref = reference;
        if (description !== undefined) {
          jsonSchema.description = description;
        }
      },
    });
  }

  const document = render(schema);
  if (definitions && Object.keys(definitions).length > 0) {
    document.$defs = Object.fromEntries(Object.entries(definitions).map(([key, definition]) => {
      const { $schema, ...body } = render(definition);
      void $schema;
      return [key, body];
    }));
  }
  return { ...document, $id: contractRef(name) };
}

for (const name of Object.keys(socialContracts) as Array<keyof typeof socialContracts>) {
  const publication = Object.hasOwn(financialContracts, name)
    ? { override: financialContractOverride }
    : socialPublications[name];
  publish(socialRoot, name, socialDocument(name, socialContracts[name], publication));
}

for (const [name, { schema, definitions }] of Object.entries(homePublishedContracts)) {
  publish(socialRoot, name, socialDocument(name, schema, { definitions, references: name === "happening-response" ? happeningReferences : homeReferences }));
}

const socialSchemaNames = [...Object.keys(socialContracts), ...Object.keys(homePublishedContracts)].sort();
const publishedSocialSchemaNames = readdirSync(socialRoot)
  .filter((file) => file.endsWith(".schema.json"))
  .map((file) => file.slice(0, -".schema.json".length))
  .sort();
assert.deepEqual(publishedSocialSchemaNames, socialSchemaNames, "Every social JSON Schema needs a source registration.");
const socialSchemaNamesPath = new URL("schema-names.generated.ts", socialRoot);
const socialSchemaNamesSource = `// Generated by packages/core/scripts/generate-contract-schemas.ts.
export const SOCIAL_SCHEMA_NAMES = [
${socialSchemaNames.map((name) => `  ${JSON.stringify(name)},`).join("\n")}
] as const;
`;
publishFile(socialSchemaNamesPath, "social schema names", socialSchemaNamesSource, readExisting(socialSchemaNamesPath));
