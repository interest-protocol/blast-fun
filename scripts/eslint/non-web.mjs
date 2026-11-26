import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig, globalIgnores } from "eslint/config";
import nextTs from "eslint-config-next/typescript";
import sonarjs from "eslint-plugin-sonarjs";
import { backendLayout } from "./backend-layout.mjs";
import { sharedControls } from "./shared-controls.mjs";
import { sharedPatterns } from "./shared-patterns.mjs";
import sleepsAllowed from "./fixed-sleeps-allowed.json" with { type: "json" };

// Shared rules are identical for full-repository and scoped worker/core lint.

// `eslint --cache` keys on each plugin's meta name and version. An inline plugin without them is keyed by
// its namespace alone, so editing a rule or its legacy allowlist would keep every cached pass. Hash their sources.
const blastUiVersion = createHash("sha256")
  .update(["shared-controls.mjs", "shared-controls-legacy.json", "shared-patterns.mjs", "shared-patterns-legacy.json"]
    .map((file) => readFileSync(new URL(file, import.meta.url))).join("\0"))
  .digest("hex");

// Package boundaries. Flat config replaces a rule's options instead of merging
// them, so each package gets exactly one no-restricted-imports block.
// ponytail: relative escapes are matched as text ("../web/...", "../apps/..."),
// not resolved; a package folder named web, workers or apps would false-positive.
const importSyntax = (patterns) => patterns.map(({ regex, message }) => ({
  selector: [
    `ImportExpression[source.value=/${regex.replaceAll("/", "\\/")}/]`,
    `CallExpression[callee.name='require'][arguments.0.value=/${regex.replaceAll("/", "\\/")}/]`,
  ].join(", "),
  message,
}));
const runtimePatterns = [
  {
    regex: "^(hono|@hono/[^/]+)(/|$)",
    message: "Use Effect HttpApi for Blast backend contracts.",
  },
  {
    caseSensitive: true,
    regex: "^effect($|/[a-z][^/]*$)",
    message: "Import each Effect module directly, for example effect/Effect or effect/http-api/HttpApi.",
  },
];
const boundary = (files, patterns = []) => {
  const restrictions = [...runtimePatterns, ...patterns];
  return {
    files,
    rules: {
      "no-restricted-imports": ["error", { patterns: restrictions }],
      "no-restricted-syntax": ["error", ...importSyntax(restrictions)],
    },
  };
};
const backendImplementation = [
  { regex: "^@blast/backend-api(/|$)", message: "Call the Render backend over HTTP." },
  { regex: "^(\\.\\.?/)*\\.\\./(apps/)?backend-api/src(/|$)", message: "Call the Render backend over HTTP." },
];
const webPatterns = [
  ...backendImplementation,
  { regex: "^#workers/", message: "apps/web must not import from apps/workers." },
  { regex: "^@blast/workers(/|$)", message: "apps/web must not import from apps/workers." },
  { regex: "^(\\.\\.?/)*\\.\\./(apps/)?workers(/|$)", message: "apps/web must not import from apps/workers." },
];
const webAlias = { regex: "^(@/|#web/)", message: "Use your package's alias or @blast/core/<path>.ts; web imports stay in apps/web." };

const backendPatterns = [
  webAlias,
  { regex: "^@blast/backend-api(/|$)", message: "Use relative imports inside the backend so layer boundaries apply." },
  { regex: "^(next|react|react-dom|@blast/(web|workers)|#workers)(/|$)", message: "The Render backend cannot depend on a frontend or worker." },
  { regex: "^(\\.\\.?/)*\\.\\./(apps/)?(web|workers)(/|$)", message: "The Render backend cannot depend on another app." },
];

const boundaries = [
  boundary(["{apps,packages}/**/*.{js,mjs,cjs,jsx,ts,tsx}"]),
  boundary(["packages/core/**"], [
    ...backendImplementation,
    { regex: "^(next|react|react-dom|server-only|client-only)(/|$)", message: "packages/core must not depend on Next or React." },
    webAlias,
    { regex: "^#workers/", message: "packages/core must not import from apps/*." },
    { regex: "^@blast/(web|workers)(/|$)", message: "packages/core must not import from apps/*." },
    { regex: "^(\\.\\.?/)*\\.\\./apps(/|$)", message: "packages/core must not import from apps/*." },
    { regex: "^@blast/server(/|$)", message: "packages/core must not import from packages/server." },
  ]),
  boundary(["apps/workers/**"], [
    ...backendImplementation,
    webAlias,
    { regex: "^@blast/web(/|$)", message: "apps/workers must not import from apps/web." },
    { regex: "^(\\.\\.?/)*\\.\\./(apps/)?web(/|$)", message: "apps/workers must not import from apps/web." },
  ]),
  boundary(["apps/web/**"], webPatterns),
  {
    ...boundary(["packages/server/src/**"], backendImplementation),
    // This integration test exercises the server use case through the backend HTTP handler.
    ignores: ["packages/server/src/modules/analytics/activity.integration.test.ts"],
  },
  boundary(["apps/backend-api/src/**"], backendPatterns),
  boundary(["apps/backend-api/src/data/api/**"], [
    ...backendPatterns,
    { regex: "^(\\./)*(\\.\\./|@blast/server(/|$))", message: "An HTTP contract uses its own files and shared core types. It cannot depend on backend handlers or services." },
  ]),
  boundary(["apps/backend-api/src/features/**"], [
    ...backendPatterns,
    { regex: "^(\\./)*\\.\\./", message: "Feature dependencies are composed in src/app. Keep imports within the feature." },
  ]),
  boundary(["apps/backend-api/src/features/market/**"], [
    ...backendPatterns,
    { regex: "^(\\./)*\\.\\./(?!\\.\\./data/api/(Api[.]ts|market/[^/]+)$)", message: "Market can import its HTTP contract and the root API. Compose dependencies across features in src/app." },
  ]),
  boundary(["apps/backend-api/src/features/health/**"], [
    ...backendPatterns,
    { regex: "^(\\./)*\\.\\./(?!\\.\\./data/api/(Api[.]ts|health/[^/]+)$)", message: "Health can import its HTTP contract and the root API. Compose dependencies across features in src/app." },
  ]),
  ...["cron", "hints", "operators", "private", "reads"].map((feature) =>
    boundary([`apps/backend-api/src/features/${feature}/**`], [
      ...backendPatterns,
      {
        regex: `^(\\./)*\\.\\./(?!\\.\\./data/api/${feature}/[^/]+$)`,
        message: "A feature can import its HTTP contract. Compose dependencies across features in src/app.",
      },
    ]),
  ),
];

// A fixed sleep then an assertion fails when the host is busy. Wait for the
// condition with `waitFor` (apps/web/test/fixtures/social/test-dom.ts). The
// files listed in fixed-sleeps-allowed.json predate this rule: remove a file
// from the list when it is converted, never add one. A test of real timers
// may disable the rule on its line, with the reason.
const sleepMessage = "Wait for a condition with waitFor from test/fixtures/social/test-dom.ts, not a fixed sleep: a busy host makes fixed sleeps flaky.";
export const fixedSleepSyntax = [
  { selector: "NewExpression[callee.name='Promise'] CallExpression[callee.name='setTimeout']", message: sleepMessage },
  { selector: "NewExpression[callee.name='Promise'] CallExpression[callee.property.name='setTimeout']", message: sleepMessage },
  { selector: "ImportExpression[source.value=/^(node:)?timers\\/promises$/]", message: sleepMessage },
  { selector: "ImportDeclaration[source.value=/^(node:)?timers\\/promises$/]", message: sleepMessage },
];
// Flat config replaces a rule's options, so web tests repeat the web boundary's syntax entries.
const fixedSleeps = {
  files: ["apps/web/**/*.test.tsx"],
  ignores: sleepsAllowed,
  rules: { "no-restricted-syntax": ["error", ...importSyntax([...runtimePatterns, ...webPatterns]), ...fixedSleepSyntax] },
};

export default defineConfig([
  ...nextTs,
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,tsx}"],
    plugins: { sonarjs },
    rules: { "sonarjs/cognitive-complexity": ["error", 15] },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports", disallowTypeAnnotations: false }],
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  {
    files: ["apps/backend-api/{src,test}/**/*.ts"],
    rules: {
      curly: ["error", "all"],
      "padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "import", next: "*" },
        { blankLine: "any", prev: "import", next: "import" },
        { blankLine: "always", prev: "*", next: "function" },
        { blankLine: "always", prev: "function", next: "*" },
        { blankLine: "always", prev: "*", next: "export" },
        { blankLine: "always", prev: "export", next: "*" },
      ],
    },
  },
  {
    files: ["apps/web/src/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    plugins: { "blast-ui": { meta: { name: "blast-ui", version: blastUiVersion }, rules: { "shared-controls": sharedControls, "shared-patterns": sharedPatterns } } },
    rules: { "blast-ui/shared-controls": "error", "blast-ui/shared-patterns": "error" },
  },
  { settings: { next: { rootDir: "apps/web/" } } },
  {
    // Server code reads parsed settings, never the environment (U8, #779).
    files: [
      "packages/core/src/**/*.{ts,tsx}",
      "packages/server/src/**/*.{ts,tsx}",
      "apps/backend-api/src/**/*.ts",
      "apps/web/src/**/*.{ts,tsx}",
    ],
    ignores: [
      "**/*.test.{ts,tsx}",
      "**/test/**",
      // Entry and config modules: they parse the environment once at boot.
      "apps/backend-api/src/app/api/config.ts",
      "apps/backend-api/src/app/hints/config.ts",
      "packages/server/src/config/runtime-config.ts",
      "packages/server/src/private/relay-config.ts",
      "apps/web/src/lib/server-config.ts",
      // NEXT_PUBLIC_* reads stay literal so Next inlines them in browser bundles.
      "apps/web/src/lib/site.ts",
      "apps/web/src/components/analytics/activity-enabled.ts",
      // Core defaults that web and the workers still pass through as `environment = process.env`.
      "packages/core/src/lib/redis.ts",
      "packages/core/src/lib/web-security/gate-cookie.ts",
      "packages/core/src/lib/web-security/rate-limits.ts",
      "packages/core/src/modules/database/pool-settings.ts",
      "packages/core/src/modules/database/topology.ts",
      "packages/core/src/modules/launchpad-coin/signing-chain.ts",
      "packages/core/src/modules/launchpad-contract/provenance.ts",
      "packages/core/src/modules/presale/deployment/service.ts",
      "packages/core/src/modules/presale/rewards/waiting.ts",
      "packages/core/src/modules/read-routing/blast-infra.ts",
      "apps/workers/src/modules/social/claims/launch.ts",
      "packages/core/src/modules/social/create/test-quote.ts",
      "packages/core/src/modules/web-security/route-limits.ts",
      "packages/core/src/modules/web-security/traffic-rate-limits.ts",
      // Flags: read live by web and the API alike.
      "packages/core/src/lib/launch-flags.ts",
      "packages/core/src/lib/social-flag.ts",
      "packages/core/src/lib/metrics.ts",
      "apps/web/src/lib/experience.ts",
      // Server files web or the hints process also loads: they must not import the API's runtime config.
      "packages/server/src/lib/site-origin.ts",
      "packages/server/src/modules/launch-assets/store.ts",
      "packages/server/src/modules/mission-control/maintenance/repository.ts",
      "packages/server/src/modules/partner-api-keys/recognition.ts",
    ],
    rules: {
      "no-restricted-properties": ["error", {
        object: "process",
        property: "env",
        message: "Read the parsed settings instead: runtimeConfig() or backendConfig in the API, webConfig() (apps/web/src/lib/server-config.ts) or relayConfig() in web; only boot parses the environment.",
      }],
    },
  },
  ...boundaries,
  ...backendLayout,
  fixedSleeps,
  globalIgnores([
    "**/.next/**",
    "**/.vercel/**",
    "**/out/**",
    "**/tmp/**",
  ]),
]);
