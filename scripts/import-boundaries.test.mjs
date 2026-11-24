import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";
import ts from "typescript";

const eslint = new ESLint();
const boundaryRules = new Set(["no-restricted-imports", "no-restricted-syntax"]);
const forms = [
  (path) => `import ${JSON.stringify(path)};`,
  (path) => `import type { Probe as ImportedProbe } from ${JSON.stringify(path)};`,
  (path) => `export * from ${JSON.stringify(path)};`,
  (path) => `export const load = () => import(${JSON.stringify(path)});`,
  (path) => `export const load = () => require(${JSON.stringify(path)});`,
];

test("backend formatting separates imports and declarations and can fix missing spacing", async () => {
  const ruleId = "padding-line-between-statements";
  const cramped = [
    'import "./first.js";',
    'import "./second.js";',
    "export type Command = string;",
    "export function parse() {}",
    "function helper() {}",
    "export const help = 'help';",
  ].join("\n");
  const readable = [
    'import "./first.js";',
    'import "./second.js";',
    "",
    "export type Command = string;",
    "",
    "export function parse() {}",
    "",
    "function helper() {}",
    "",
    "export const help = 'help';",
  ].join("\n");

  for (const filePath of ["apps/backend-api/src/probe.ts", "apps/backend-api/test/probe.test.ts"]) {
    const [rejected] = await eslint.lintText(cramped, { filePath });
    assert.equal(rejected.messages.filter((message) => message.ruleId === ruleId).length, 4);
    const [accepted] = await eslint.lintText(readable, { filePath });
    assert.ok(!accepted.messages.some((message) => message.ruleId === ruleId));
    const [fixed] = await new ESLint({ fix: true }).lintText(cramped, { filePath });
    assert.equal(fixed.output, readable);
  }

  const config = await eslint.calculateConfigForFile("apps/workers/src/probe.ts");
  assert.equal(config.rules[ruleId], undefined, "Backend spacing rules stay scoped to the backend");
});

test("backend formatting requires braces around control-flow bodies", async () => {
  const ruleId = "curly";
  for (const filePath of ["apps/backend-api/src/probe.ts", "apps/backend-api/test/probe.test.ts"]) {
    const [rejected] = await eslint.lintText("if (ready) work();", { filePath });
    assert.equal(rejected.messages.filter((message) => message.ruleId === ruleId).length, 1);
    const [fixed] = await new ESLint({ fix: true }).lintText("if (ready) work();", { filePath });
    assert.equal(fixed.output, "if (ready) {work();}");
    assert.ok(!fixed.messages.some((message) => message.ruleId === ruleId));
  }
});

test("backend source uses structured logging instead of direct console calls", async () => {
  for (const filePath of [
    "apps/backend-api/src/app/api/start.ts",
    "apps/backend-api/src/app/hints/start.ts",
    "apps/backend-api/src/transport/http.ts",
  ]) {
    const [result] = await eslint.lintText('console.warn("unstructured");', { filePath });
    assert.equal(result.fatalErrorCount, 0);
    assert.equal(result.messages.filter(({ ruleId }) => ruleId === "no-console").length, 1, filePath);
  }
});

test("cognitive complexity accepts 15 and rejects 16 in production, tests and tooling", async () => {
  const ruleId = "sonarjs/cognitive-complexity";
  const probe = (branches) => `export function probe(value) { let result = 0; ${Array.from({ length: branches }, (_, index) => `if (value === ${index}) result += ${index};`).join(" ")} return result; }`;
  for (const filePath of [
    "packages/core/src/probe.ts",
    "apps/workers/src/probe.ts",
    "apps/web/src/probe.tsx",
    "apps/web/src/probe.test.ts",
    "scripts/probe.mjs",
    "apps/web/loadtest/probe.ts",
    "docs/workflows/probe.js",
  ]) {
    const config = await eslint.calculateConfigForFile(filePath);
    assert.deepEqual(config.rules[ruleId], [2, 15], filePath);
    const [accepted] = await eslint.lintText(probe(15), { filePath });
    assert.deepEqual(accepted.messages.filter((message) => message.ruleId === ruleId || message.fatal), [], filePath);
    const [rejected] = await eslint.lintText(probe(16), { filePath });
    assert.equal(rejected.messages.filter((message) => message.ruleId === ruleId && message.severity === 2).length, 1, filePath);
    assert.ok(rejected.messages.some((message) => message.ruleId === ruleId && message.message.includes("from 16 to the 15 allowed")), filePath);
  }
});

test("type-only imports retain aliases without loading modules", async () => {
  for (const [filePath, alias] of [["packages/core/src/probe.ts", "@blast/core/lib/site.ts"], ["apps/workers/src/probe.ts", "#workers/site.ts"], ["apps/web/src/probe.ts", "#web/lib/site.ts"]]) {
    const declaration = `{ Probe as ImportedProbe } from ${JSON.stringify(alias)}; export type Contract = ImportedProbe;`;
    const [unmarked] = await eslint.lintText(`import ${declaration}`, { filePath });
    assert.ok(unmarked.messages.some(({ ruleId }) => ruleId === "@typescript-eslint/consistent-type-imports"));
    const [inline] = await eslint.lintText(`import { type Probe as ImportedProbe } from ${JSON.stringify(alias)}; export type Contract = ImportedProbe;`, { filePath });
    assert.ok(inline.messages.some(({ ruleId }) => ruleId === "@typescript-eslint/no-import-type-side-effects"));
    const source = `import type ${declaration}`;
    const [explicit] = await eslint.lintText(source, { filePath });
    assert.deepEqual(explicit.messages, []);
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
    });
    assert.doesNotMatch(outputText, /\bimport\b/);
  }
});

test("package boundaries reject static, dynamic and CommonJS imports", async () => {
  for (const [filePath, forbidden] of [
    ["packages/core/src/probe.ts", ["hono", "next/server", "react", "server-only", "@/lib/site", "#web/lib/site.ts", "#web/scripts/codemods/clsx-core.ts", "#workers/job.ts", "@blast/web/site", "../../../apps/web/src/site.ts"]],
    ["apps/workers/src/probe.ts", ["hono", "effect", "@/lib/site", "#web/lib/site.ts", "#web/scripts/codemods/clsx-core.ts", "@blast/web/site", "../../web/src/site.ts"]],
    ["apps/web/src/probe.ts", ["hono/tiny", "#workers/job.ts", "@blast/workers/job", "../../workers/src/job.ts"]],
    ["apps/web/src/probe.test.tsx", ["hono"]],
    ["packages/server/src/modules/analytics/activity.integration.test.ts", ["hono"]],
  ]) {
    for (const path of forbidden) for (const form of forms) {
      const [result] = await eslint.lintText(form(path), { filePath });
      assert.ok(!result.messages.some((message) => message.fatal), JSON.stringify(result.messages));
      assert.ok(result.messages.some(({ ruleId }) => boundaryRules.has(ruleId)), `${filePath}: ${form(path)}`);
    }
  }
});

test("Effect backend imports point toward owned contracts and direct Effect modules", async () => {
  const market = "apps/backend-api/src/features/market/handlers.ts";
  const health = "apps/backend-api/src/features/health/handlers.ts";
  const contract = "apps/backend-api/src/data/api/market/MarketApi.ts";
  const app = "apps/backend-api/src/app/api/effect-http.ts";
  for (const [filePath, path] of [
    [app, "effect"],
    [app, "hono"],
    [app, "@hono/node-server"],
    [market, "effect/http-api"],
    [market, "../prices/handlers.ts"],
    [market, "./../prices/handlers.ts"],
    [market, "../../data/api/prices/PricesApi.ts"],
    [market, "../../app/api/effect-http.ts"],
    [market, "@blast/backend-api/src/app/api/effect-http.ts"],
    [health, "../market/handlers.ts"],
    [health, "../../data/api/market/MarketApi.ts"],
    [contract, "../../../features/market/handlers.ts"],
    [contract, "@blast/backend-api/src/features/market/handlers.ts"],
    [contract, "../prices/schemas.ts"],
    [contract, "@blast/server/modules/launchpad-market/routes.ts"],
    [app, "../../../../web/src/modules/partner-api/v1/relay.ts"],
    ["apps/web/src/probe.ts", "../../backend-api/src/app/api/effect-http.ts"],
    ["packages/server/src/probe.ts", "@blast/backend-api/src/app/api/effect-http.ts"],
    ["packages/server/src/probe.ts", "../../../apps/backend-api/src/app/api/effect-http.ts"],
  ]) {
    for (const form of forms) {
      const [result] = await eslint.lintText(form(path), { filePath });
      assert.ok(!result.messages.some(({ fatal }) => fatal), path);
      assert.ok(result.messages.some(({ ruleId }) => boundaryRules.has(ruleId)), `${filePath}: ${form(path)}`);
    }
  }
  for (const [filePath, path] of [
    [market, "./local.ts"],
    [market, "../../data/api/Api.ts"],
    [market, "../../data/api/market/MarketApi.ts"],
    [health, "../../data/api/Api.ts"],
    [health, "../../data/api/health/HealthApi.ts"],
    [contract, "effect/http-api/HttpApi"],
    [contract, "@blast/core/lib/sui/ids.ts"],
    [app, "effect/Layer"],
    ["apps/workers/src/probe.ts", "effect/Effect"],
    [app, "../../features/market/handlers.ts"],
    ["packages/server/src/modules/analytics/activity.integration.test.ts", "../../../../../apps/backend-api/src/transport/private.ts"],
  ]) {
    for (const form of forms) {
      const [result] = await eslint.lintText(form(path), { filePath });
      assert.deepEqual(result.messages.filter(({ ruleId, fatal }) => fatal || boundaryRules.has(ruleId)), [], `${filePath}: ${form(path)}`);
    }
  }
});

test("backend transport and process wiring enforce one-way imports", async () => {
  const api = "app/api/start.ts";
  const hints = "app/hints/start.ts";
  const shared = "app/server.ts";
  const transport = "transport/http.ts";
  const lint = async (file, code) => {
    const [result] = await eslint.lintText(code, { filePath: `apps/backend-api/src/${file}` });
    assert.equal(result.fatalErrorCount, 0);
    return result.messages.filter(({ ruleId }) => ruleId === "blast-backend/layout" || ruleId === "no-restricted-globals");
  };

  for (const [file, path] of [
    [transport, "../app/server.ts"],
    [transport, "../features/health/handlers.ts"],
    [api, "../hints/server.ts"],
    [hints, "../config/../api/config.ts"],
    ["hints-main.ts", "./app/api/start.ts"],
    ["main.ts", "./app/hints/start.ts"],
    ["shared.ts", "./app/api/routing.ts"],
    [shared, "./api/routing.ts"],
    ["app/config/transport.ts", "../hints/config.ts"],
    [shared, "../main.ts"],
    [api, "bun"],
    [hints, "bun:sqlite"],
  ]) {
    for (const form of forms) {
      assert.equal((await lint(file, form(path))).length, 1, `${file}: ${form(path)}`);
    }
  }
  assert.equal((await lint(hints, 'export const load = () => import(`../api/start.ts`);')).length, 1);
  assert.equal((await lint(hints, 'export type Probe = import("../api/config.ts").Probe;')).length, 1);
  assert.equal((await lint(api, "globalThis.Bun.serve({});")).length, 1);
  assert.equal((await lint(transport, "Bun.serve({});")).length, 0);
  for (const [file, path] of [
    ["main.ts", "./app/api/start.ts"],
    ["hints-main.ts", "./app/hints/start.ts"],
    [api, "../server.ts"],
    [hints, "../config/fleet.ts"],
    [shared, "../transport/http.ts"],
    [transport, "./health.ts"],
    [transport, "bun"],
  ]) {
    assert.deepEqual(await lint(file, forms[0](path)), [], `${file}: ${path}`);
  }
});

// This fails if web or relay code may read process.env again, or if a config
// entry (runtime, relay, web) or the NEXT_PUBLIC_ site module loses its allowance.
test("only boot and the allowlisted files read process.env; tests may, and the boundary rules still apply alongside", async () => {
  const ruleId = "no-restricted-properties";
  const source = "export const origin = process.env.BLAST_INFRA_ORIGIN;";
  // The web files and the relays (allowlisted until U8 PR 5) read webConfig() or relayConfig().
  for (const filePath of [
    "packages/server/src/modules/presale/probe.ts",
    "packages/core/src/probe.ts",
    "apps/backend-api/src/probe.ts",
    "apps/web/src/lib/probe.ts",
    "apps/web/src/app/probe/page.tsx",
    "packages/server/src/cron/relay.ts",
    "packages/server/src/private/relay.ts",
  ]) {
    const [rejected] = await eslint.lintText(source, { filePath });
    assert.equal(rejected.messages.filter((message) => message.ruleId === ruleId).length, 1, filePath);
  }
  const [both] = await eslint.lintText(`import "#web/lib/site.ts"; ${source}`, { filePath: "packages/core/src/probe.ts" });
  assert.ok(both.messages.some((message) => message.ruleId === ruleId));
  assert.ok(both.messages.some((message) => boundaryRules.has(message.ruleId)));
  for (const filePath of [
    "packages/server/src/config/runtime-config.ts",
    "apps/backend-api/src/app/api/config.ts",
    "apps/backend-api/src/app/hints/config.ts",
    "packages/server/src/modules/presale/probe.test.ts",
    "packages/server/src/private/relay-config.ts",
    "apps/web/src/lib/server-config.ts",
    "apps/web/src/lib/site.ts",
    "apps/web/src/lib/probe.test.ts",
  ]) {
    const [accepted] = await eslint.lintText(source, { filePath });
    assert.deepEqual(accepted.messages.filter((message) => message.ruleId === ruleId), [], filePath);
  }
});

test("package boundaries allow local files and the shared core package", async () => {
  for (const [filePath, alias] of [["packages/core/src/probe.ts", "@blast/core/lib/site.ts"], ["apps/workers/src/probe.ts", "#workers/site.ts"], ["apps/web/src/probe.ts", "#web/lib/site.ts"]]) {
    for (const path of ["./local.ts", "@blast/core/lib/exact-amount.ts", "node:crypto", alias]) for (const form of forms) {
      const [result] = await eslint.lintText(form(path), { filePath });
      assert.deepEqual(result.messages.filter(({ ruleId }) => boundaryRules.has(ruleId)), [], `${filePath}: ${form(path)}`);
    }
  }
});
