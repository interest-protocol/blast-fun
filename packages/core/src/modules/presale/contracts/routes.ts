import {
  INFRA_ERROR_CODES as INFRA,
  PRESALE_ERRORS,
  ROUTE_KIT_ERROR_CODES as KIT,
  type PresaleErrorBodies,
  type PresaleErrorCode,
} from "./errors.ts";
import type {
  PresaleClaimedMessage,
  PresaleCommitmentsResponse,
  PresaleCommittedMessage,
  PresaleCreatedMessage,
  PresaleLifecycleMessage,
  PresaleListResponse,
  PresaleOpenedMessage,
  PresalePolicyResponse,
  PresaleProjectionPayload,
  PresaleSnapshotMessage,
  PresaleSnapshotUnavailableMessage,
  PresaleWalletResponse,
  WalletPresalesResponse,
} from "./read-path.ts";
import type {
  AccountSettingsRequest,
  AccountSettingsResponse,
  AccountWalletsResponse,
  AllowlistBindRequest,
  AllowlistBindResponse,
  AllowlistCreateRequest,
  AllowlistEntriesResponse,
  AllowlistProofResponse,
  AllowlistResponse,
  BridgeQuoteResponse,
  BridgeTransferCreatedResponse,
  BridgeTransferRequest,
  BridgeTransferStatusResponse,
  ExecuteRequest,
  ExecuteResponse,
  OutcomeRequest,
  OutcomeResponse,
  RewardAllocationsResponse,
  RewardManifestResponse,
  SponsorRequest,
  SponsorResponse,
} from "./web-api.ts";

/** The one type of each schema, by schema name (its path under `schemas/` without `.schema.json`). */
export type PresaleSchemaTypes = {
  "presale-list": PresaleListResponse;
  "presale-projection": PresaleProjectionPayload;
  "presale-commitments": PresaleCommitmentsResponse;
  "presale-wallet": PresaleWalletResponse;
  "wallet-presales": WalletPresalesResponse;
  "presale-policy": PresalePolicyResponse;
  "ws-presale-snapshot": PresaleSnapshotMessage;
  "ws-presale-snapshot-unavailable": PresaleSnapshotUnavailableMessage;
  "ws-presale-committed": PresaleCommittedMessage;
  "ws-presale-lifecycle": PresaleLifecycleMessage;
  "ws-presale-claimed": PresaleClaimedMessage;
  "ws-presale-created": PresaleCreatedMessage;
  "ws-presale-opened": PresaleOpenedMessage;
  "sponsor-request": SponsorRequest;
  "sponsor-response": SponsorResponse;
  "execute-request": ExecuteRequest;
  "execute-response": ExecuteResponse;
  "allowlist-create-request": AllowlistCreateRequest;
  "allowlist-response": AllowlistResponse;
  "allowlist-entries-response": AllowlistEntriesResponse;
  "allowlist-bind-request": AllowlistBindRequest;
  "allowlist-bind-response": AllowlistBindResponse;
  "allowlist-proof-response": AllowlistProofResponse;
  "bridge-quote-response": BridgeQuoteResponse;
  "bridge-transfer-request": BridgeTransferRequest;
  "bridge-transfer-created-response": BridgeTransferCreatedResponse;
  "bridge-transfer-status-response": BridgeTransferStatusResponse;
  "account-settings-request": AccountSettingsRequest;
  "account-settings-response": AccountSettingsResponse;
  "outcome-request": OutcomeRequest;
  "outcome-response": OutcomeResponse;
  "account-wallets-response": AccountWalletsResponse;
  "reward-allocations-response": RewardAllocationsResponse;
  "reward-manifest-response": RewardManifestResponse;
} & { [Code in PresaleErrorCode as `errors/${Code}`]: PresaleErrorBodies[Code] };

export type PresaleSchemaName = keyof PresaleSchemaTypes;

/** Every payload schema name: the route and topic payloads, then one per error code. */
export const PRESALE_SCHEMA_NAMES = [
  "presale-list",
  "presale-projection",
  "presale-commitments",
  "presale-wallet",
  "wallet-presales",
  "presale-policy",
  "ws-presale-snapshot",
  "ws-presale-snapshot-unavailable",
  "ws-presale-committed",
  "ws-presale-lifecycle",
  "ws-presale-claimed",
  "ws-presale-created",
  "ws-presale-opened",
  "sponsor-request",
  "sponsor-response",
  "execute-request",
  "execute-response",
  "allowlist-create-request",
  "allowlist-response",
  "allowlist-entries-response",
  "allowlist-bind-request",
  "allowlist-bind-response",
  "allowlist-proof-response",
  "bridge-quote-response",
  "bridge-transfer-request",
  "bridge-transfer-created-response",
  "bridge-transfer-status-response",
  "account-settings-request",
  "account-settings-response",
  "outcome-request",
  "outcome-response",
  "account-wallets-response",
  "reward-allocations-response",
  "reward-manifest-response",
  ...(Object.keys(PRESALE_ERRORS) as PresaleErrorCode[]).map((code) => `errors/${code}` as const),
] as const satisfies readonly PresaleSchemaName[];
// The list names every schema the type map does: a missing name fails typecheck here.
const everySchemaListed: [Exclude<PresaleSchemaName, (typeof PRESALE_SCHEMA_NAMES)[number]>] extends [never] ? true : false = true;
void everySchemaListed;

type Route = {
  /** The JSON request body's schema. */
  request?: PresaleSchemaName;
  /** Query parameters; a malformed one, like a malformed path parameter, is `invalid_parameter` (CL-21). */
  query?: readonly string[];
  /** Success responses by status; `null` is a non-JSON body. */
  responses: Readonly<Record<number, PresaleSchemaName | null>>;
  errors: readonly PresaleErrorCode[];
  /** Notes the schemas cannot carry. */
  note?: string;
};

/** The upload is capped at 4 MiB with `allowlist_too_large` instead of the kit's `body_too_large`. */
const ALLOWLIST_CREATE_KIT = ["rate_limited", "origin_invalid", "invalid_request", "service_unavailable"] as const;

/** Every presale route: its payload schemas and every error code it can return. */
export const PRESALE_ROUTES = {
  // Read path, blast-infra `/v1`
  "GET /v1/presales": { responses: { 200: "presale-list" }, errors: INFRA },
  "GET /v1/presales/{presale_id}": { responses: { 200: "presale-projection" }, errors: INFRA },
  "GET /v1/presales/{presale_id}/commitments": { responses: { 200: "presale-commitments" }, errors: INFRA },
  "GET /v1/presales/{presale_id}/wallets/{address}": { responses: { 200: "presale-wallet" }, errors: INFRA },
  "GET /v1/wallets/{address}/presales": { responses: { 200: "wallet-presales" }, errors: INFRA },
  "GET /v1/presales/policy": { responses: { 200: "presale-policy" }, errors: INFRA },
  // Web API
  "POST /api/presale/sponsor": {
    request: "sponsor-request",
    responses: { 200: "sponsor-response" },
    errors: [
      "unauthorized",
      "not_embedded_wallet",
      "target_not_allowed",
      "dry_run_failed",
      "budget_exceeded",
      "pool_unavailable",
      "identity_unavailable",
      "deployment_unavailable",
      "deployment_mismatch",
      ...KIT,
    ],
  },
  "POST /api/presale/sponsor/{reservation_id}/execute": {
    request: "execute-request",
    responses: { 200: "execute-response" },
    errors: [
      "unauthorized",
      "invalid_signature",
      "not_found",
      "reservation_expired",
      "execution_unconfirmed",
      "invalid_parameter",
      ...KIT,
    ],
  },
  "POST /api/presale/allowlists": {
    request: "allowlist-create-request",
    responses: { 201: "allowlist-response" },
    errors: ["invalid_allowlist", "allowlist_too_large", "unauthorized", ...ALLOWLIST_CREATE_KIT],
    note: "JSON, or multipart/form-data with a file part `file` (CSV header `wallet,cap`) and a form field `quote`; over 4 MiB is allowlist_too_large.",
  },
  "GET /api/presale/allowlists/{allowlist_id}": {
    responses: { 200: "allowlist-response" },
    errors: ["not_found", "unauthorized", "invalid_parameter", ...KIT],
    note: "Agent read of an owned manifest; not_found for a manifest the caller does not own.",
  },
  "GET /api/presale/allowlists/{allowlist_id}/entries": {
    responses: { 200: "allowlist-entries-response" },
    errors: ["not_found", "unauthorized", "invalid_parameter", ...KIT],
    note: "Owner-only saved wallets and exact contribution caps, in index order.",
  },
  "POST /api/presale/allowlists/{allowlist_id}/bind": {
    request: "allowlist-bind-request",
    responses: { 200: "allowlist-bind-response" },
    errors: [
      "root_mismatch",
      "not_found",
      "unauthorized",
      "deployment_unavailable",
      "deployment_mismatch",
      "invalid_parameter",
      ...KIT,
    ],
  },
  "GET /api/presale/presales/{presale_id}/proof": {
    query: ["wallet"],
    responses: { 200: "allowlist-proof-response" },
    errors: ["not_eligible", "allowlist_unknown", "deployment_unavailable", "deployment_mismatch", "invalid_parameter", ...KIT],
  },
  "GET /api/presale/bridge/quote": {
    query: ["source", "amount"],
    responses: { 200: "bridge-quote-response" },
    errors: ["bridge_unavailable", "invalid_parameter", ...KIT],
  },
  "POST /api/presale/bridge/transfers": {
    request: "bridge-transfer-request",
    responses: { 201: "bridge-transfer-created-response", 200: "bridge-transfer-created-response" },
    errors: ["bridge_unavailable", "invalid_parameter", ...KIT],
  },
  "GET /api/presale/bridge/transfers/{id}": {
    responses: { 200: "bridge-transfer-status-response" },
    errors: ["bridge_unavailable", "invalid_parameter", "not_found", ...KIT],
    note: "not_found for an unknown transfer id (CL-18).",
  },
  "GET /api/presale/receipts/{presale_id}/{wallet}/image": {
    query: ["format"],
    responses: { 200: null },
    errors: ["invalid_parameter", "not_found", ...KIT],
    note: "200 is image/png (CL-9); busy is service_unavailable.",
  },
  "GET /api/account/settings": { responses: { 200: "account-settings-response" }, errors: ["unauthorized", ...KIT] },
  "PUT /api/account/settings": {
    request: "account-settings-request",
    responses: { 200: "account-settings-response" },
    errors: ["invalid_settings", "unauthorized", ...KIT],
  },
  "POST /api/presale/outcomes/commitments": {
    request: "outcome-request",
    responses: { 201: "outcome-response", 200: "outcome-response" },
    errors: ["no_visitor", ...KIT],
  },
  "POST /api/presale/outcomes": {
    request: "outcome-request",
    responses: { 201: "outcome-response", 200: "outcome-response" },
    errors: ["not_found", ...KIT],
    note: "Optional bearer token: a missing, invalid, or expired one is ignored, never unauthorized (CL-22).",
  },
  "GET /api/account/wallets": { responses: { 200: "account-wallets-response" }, errors: ["unauthorized", "not_found", ...KIT] },
  "GET /api/presale/rewards/{presale_id}/wallets/{wallet}": {
    responses: { 200: "reward-allocations-response" },
    errors: ["invalid_parameter", ...KIT],
  },
  "GET /api/presale/rewards/rounds/{round_id}/manifest": {
    responses: { 200: "reward-manifest-response" },
    errors: ["not_found", "invalid_parameter", ...KIT],
  },
} as const satisfies Record<string, Route>;

export type PresaleRoute = keyof typeof PRESALE_ROUTES;

/** The error bodies `route` can return. */
export type PresaleRouteError<R extends PresaleRoute> = PresaleErrorBodies[(typeof PRESALE_ROUTES)[R]["errors"][number]];

/**
 * blast-infra `/v1/ws` presale topics and their messages, by `type`. Only
 * `snapshot` carries `topic`; a log message reaches a connection once however
 * many of its topics match (CL-20). Control messages (`hello`,
 * `resume_complete`, `resync_required`, `reconnect`, `pong`, `error`) are
 * blast-infra's `ws_*` messages, unchanged (CL-4).
 */
export const PRESALE_TOPICS = {
  "presale:<presale_id>": {
    messages: {
      snapshot: "ws-presale-snapshot",
      snapshot_unavailable: "ws-presale-snapshot-unavailable",
      committed: "ws-presale-committed",
      lifecycle: "ws-presale-lifecycle",
      claimed: "ws-presale-claimed",
    },
  },
  presale_feed: {
    messages: {
      presale_created: "ws-presale-created",
      presale_opened: "ws-presale-opened",
      lifecycle: "ws-presale-lifecycle",
    },
  },
} as const satisfies Record<string, { messages: Record<string, PresaleSchemaName> }>;
