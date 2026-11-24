import {
  PARTNER_ADMIN_HTTP_MS,
  PARTNER_ADMIN_OPERATION_MS,
} from "./admin-budget.ts";
import {
  routePattern,
  type RouteParamPatterns,
  type RoutePath,
} from "./route-path.ts";

/**
 * `operator`: the transport requires the `PRESALE_ADMIN_TOKEN` bearer before admission.
 * `login-admission`: a separate credential its owner checks; the operator token never opens it.
 */
type OperatorAuth = "operator" | "login-admission";

export const OPERATOR_COIN_SEGMENT_LIMIT = 6144;

type OperatorRoute = Readonly<{
  id: string;
  path: RoutePath;
  params?: RouteParamPatterns;
  /** The transport refuses only methods outside every row's list; the owner answers per-route 405s. */
  methods: readonly ("GET" | "POST" | "PUT")[];
  auth: OperatorAuth;
  /** HTTP lifetime of the request; omitted routes keep the transport deadline. */
  workBudgetMs?: number;
  /** The owner's operation is aborted at this deadline, inside `workBudgetMs`. */
  operationDeadlineMs?: number;
}>;

/** Every `/api/admin/...` endpoint. Any other path under `/api/admin` is not found. */
export const OPERATOR_ROUTES = Object.freeze([
  {
    id: "partner-keys",
    path: "/api/admin/partner-keys",
    methods: ["GET", "POST"],
    auth: "operator",
    workBudgetMs: PARTNER_ADMIN_HTTP_MS,
    operationDeadlineMs: PARTNER_ADMIN_OPERATION_MS,
  },
  {
    id: "presales",
    path: "/api/admin/presales",
    methods: ["GET", "POST"],
    auth: "operator",
  },
  {
    id: "bonding-feature",
    path: "/api/admin/bonding-feature",
    methods: ["GET", "POST"],
    auth: "operator",
  },
  {
    id: "verified-mark",
    path: "/api/admin/verified-mark",
    methods: ["GET", "POST"],
    auth: "operator",
  },
  {
    id: "reward-coins",
    path: "/api/admin/reward-coins",
    methods: ["GET"],
    auth: "operator",
  },
  {
    id: "reward-blacklist",
    // Coin types are URL-encoded.
    path: "/api/admin/coins/:coin_type/reward-blacklist",
    params: { coin_type: `[^/]{1,${OPERATOR_COIN_SEGMENT_LIMIT}}` },
    methods: ["GET", "PUT"],
    auth: "operator",
  },
  {
    id: "gas-pool-health",
    path: "/api/admin/gas-pool/health",
    methods: ["GET"],
    auth: "operator",
  },
  {
    id: "login-admission",
    path: "/api/admin/login-admission",
    methods: ["POST"],
    auth: "login-admission",
  },
] as const satisfies readonly OperatorRoute[]);

export type OperatorRouteId = (typeof OPERATOR_ROUTES)[number]["id"];

/** A method no operator route accepts is refused before the path is looked up. */
export const OPERATOR_METHODS: ReadonlySet<string> = new Set(
  OPERATOR_ROUTES.flatMap((route) => route.methods),
);

type OperatorRow = OperatorRoute & Readonly<{ id: OperatorRouteId }>;

const ROWS: readonly OperatorRow[] = OPERATOR_ROUTES;
const MATCHERS = ROWS.map((route) => ({
  route,
  pattern: routePattern(route.path, route.params),
}));

export function operatorRoute(pathname: string): Readonly<{
  route: OperatorRow;
  params: Readonly<Record<string, string>>;
}> | null {
  for (const { route, pattern } of MATCHERS) {
    const match = pattern.exec(pathname);
    if (match) {
      return { route, params: { ...match.groups } };
    }
  }
  return null;
}
