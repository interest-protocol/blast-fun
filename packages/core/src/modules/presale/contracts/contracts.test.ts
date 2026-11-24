import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PRESALE_ABORTS, PRESALE_LIFECYCLES } from "@interest-protocol/blast-sdk/presale";

import { PRESALE_EXAMPLES } from "./examples.ts";
import { PRESALE_ELIGIBILITY_KINDS, PRESALE_VENUES } from "./wire.ts";
import { PRESALE_ERRORS, type PresaleErrorCode } from "./errors.ts";
import { PRESALE_ROUTES, PRESALE_SCHEMA_NAMES, PRESALE_TOPICS, type PresaleSchemaName } from "./routes.ts";
import { createBranchCoverage } from "./schema-branches.ts";
import { createPresaleValidator, presaleSchemaFiles } from "./validate.ts";
import { PRESALE_VARIANTS } from "./variants.ts";

const validator = createPresaleValidator();

function example(name: PresaleSchemaName): Record<string, unknown> {
  return structuredClone(PRESALE_EXAMPLES[name]) as Record<string, unknown>;
}

function assertValid(name: PresaleSchemaName, value: unknown): void {
  const result = validator.validate(name, value);
  assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.errors)}`);
}

function assertInvalid(name: PresaleSchemaName, value: unknown, why: string): void {
  assert.equal(validator.validate(name, value).valid, false, `${name} accepted ${why}`);
}

function typedPayloads(): [PresaleSchemaName, unknown][] {
  return PRESALE_SCHEMA_NAMES.flatMap((name) => [
    [name, PRESALE_EXAMPLES[name]] as [PresaleSchemaName, unknown],
    ...(PRESALE_VARIANTS[name] ?? []).map((value) => [name, value] as [PresaleSchemaName, unknown]),
  ]);
}

test("every example payload validates against its schema", () => {
  for (const name of PRESALE_SCHEMA_NAMES) assertValid(name, PRESALE_EXAMPLES[name]);
});

test("every typed variant validates against its schema", () => {
  for (const [name, value] of typedPayloads()) assertValid(name, value);
});

test("every anyOf/oneOf alternative and enum member of every schema is reached by a typed example or variant (Q-001, Q-009)", () => {
  const coverage = createBranchCoverage();
  const reached = new Set<string>();
  for (const [name, value] of typedPayloads()) coverage.reached(name, value, reached);
  const missing = coverage.alternatives().filter((alternative) => !reached.has(alternative));
  assert.deepEqual(missing, [], "schema branches no typed value reaches");
  assert.ok(
    coverage.alternatives().some((branch) => branch.endsWith("sponsor-request.schema.json#/properties/intent/enum/4")),
    "enum members count as branches",
  );
  assert.ok(
    !coverage.alternatives().some((branch) => branch.includes("#/$defs/presale_abort_name/enum/")),
    "SDK-tied enums are exempt",
  );
});

test("every schema rejects its example without a required field or with an unknown one", () => {
  for (const name of PRESALE_SCHEMA_NAMES) {
    const required = validator.requiredFields(name);
    assert.ok(required.length > 0, `${name} requires no field`);
    for (const field of required) {
      const value = example(name);
      delete value[field];
      assertInvalid(name, value, `a payload without ${field}`);
    }
    assertInvalid(name, { ...example(name), unexpected: true }, "an unknown field");
  }
  // Social UI-14: a presale intent needs its presale, and a withdrawal names none.
  const { presale_id: presale, ...withoutPresale } = example("sponsor-request");
  assertInvalid("sponsor-request", withoutPresale, "a commit without presale_id");
  assertInvalid("sponsor-request", { ...withoutPresale, presale_id: presale, intent: "withdraw" }, "a withdrawal with a presale_id");
});

test("the schemas are exactly the route, topic, and error payloads, each with one example", () => {
  const referenced = new Set<string>([
    ...Object.values(PRESALE_ROUTES).flatMap((route) => [
      ...("request" in route ? [route.request] : []),
      ...Object.values(route.responses).filter((schema) => schema !== null),
    ]),
    ...Object.values(PRESALE_TOPICS).flatMap((topic) => Object.values(topic.messages)),
    ...Object.keys(PRESALE_ERRORS).map((code) => `errors/${code}`),
  ]);
  assert.deepEqual([...referenced].sort(), [...PRESALE_SCHEMA_NAMES].sort());
  assert.deepEqual(presaleSchemaFiles().sort(), [...PRESALE_SCHEMA_NAMES].sort());
  assert.deepEqual(Object.keys(PRESALE_EXAMPLES).sort(), [...PRESALE_SCHEMA_NAMES].sort());
});

test("every route error code has one schema whose example carries that code", () => {
  for (const [route, { errors }] of Object.entries(PRESALE_ROUTES)) {
    assert.ok(errors.length > 0, `${route} lists no error code`);
    for (const code of errors) assert.ok(Object.hasOwn(PRESALE_ERRORS, code), `${route}: ${code}`);
  }
  for (const code of Object.keys(PRESALE_ERRORS) as PresaleErrorCode[]) {
    const body = PRESALE_EXAMPLES[`errors/${code}`] as { error: { code: string } };
    assert.equal(body.error.code, code);
    assertInvalid(`errors/${code}`, { error: { ...body.error, code: "not_a_code" } }, "another code");
  }
});

test("the GET /v1/presales summary has exactly the published fields", () => {
  assert.deepEqual(PRESALE_ROUTES["GET /v1/presales"].responses, { 200: "presale-list" });
  assert.deepEqual(validator.requiredFields("presale-list").sort(), ["freshness", "next_cursor", "presales"]);
  assert.deepEqual(validator.definitionFields("presale_summary").sort(), [
    "cancellation_reason",
    "created",
    "eligibility_kind",
    "lifecycle",
    "presale_id",
    "quote",
    "raise",
    "sale_token",
    "totals",
    "venue",
    "windows",
  ]);
  const list = example("presale-list") as { presales: Record<string, unknown>[] };
  const [summary] = list.presales;
  for (const [field, value] of [
    ["raise", { target: "1000", pool_share: "500" }],
    ["venue", { kind: "cetus", pool_id: null, tick_spacing: 60 }],
    ["created", { checkpoint: 1 }],
  ] as const) {
    assertInvalid("presale-list", { ...list, presales: [{ ...summary, [field]: value }] }, `summary ${field}`);
  }
});

test("enumerations follow the SDK", () => {
  assert.deepEqual(
    validator.definitionEnum("lifecycle"),
    PRESALE_LIFECYCLES.map((lifecycle) => lifecycle.toLowerCase()),
  );
  assert.deepEqual(
    validator.definitionEnum("presale_abort_name").sort(),
    [...new Set(Object.values(PRESALE_ABORTS).flat())].sort(),
  );
  assert.deepEqual(validator.definitionEnum("venue_kind"), [...PRESALE_VENUES]);
  assert.deepEqual(validator.definitionEnum("eligibility_kind"), [...PRESALE_ELIGIBILITY_KINDS]);
  const projection = JSON.parse(
    readFileSync(new URL("./schemas/presale-projection.schema.json", import.meta.url), "utf8"),
  ) as { properties: { eligibility: { oneOf: { properties: { kind: { const: string } } }[] } } };
  assert.deepEqual(
    projection.properties.eligibility.oneOf.map((branch) => branch.properties.kind.const),
    [...PRESALE_ELIGIBILITY_KINDS],
  );
  assert.deepEqual(validator.definitionEnum("clmm_venue_kind"), PRESALE_VENUES.filter((venue) => venue !== "aftermath"));
});

test("an Aftermath venue carries the vendor, its PoolCreation binding and its pools, and no CLMM tier", () => {
  const projection = example("presale-projection") as Record<string, unknown>;
  const aftermath = {
    kind: "aftermath",
    vendor_package_id: `0x${"af".repeat(32)}`,
    pool_creation_id: null,
    lp_type: null,
    pool_id: null,
    dao_fee_pool_id: null,
  };
  assert.equal(validator.validate("presale-projection", { ...projection, venue: aftermath }).valid, true);
  assertInvalid("presale-projection", { ...projection, venue: { ...aftermath, tick_spacing: 60 } }, "an Aftermath venue with a tier");
  assertInvalid("presale-projection", { ...projection, venue: { ...aftermath, vendor_package_id: null } }, "an Aftermath venue without its vendor");
  const partial = Object.fromEntries(Object.entries(aftermath).filter(([key]) => key !== "dao_fee_pool_id"));
  assertInvalid("presale-projection", { ...projection, venue: partial }, "an Aftermath venue missing a field");
  assertInvalid("presale-projection", { ...projection, venue: { kind: "aftermath", tick_spacing: 60, pool_fee_rate: "0", pool_id: null } }, "a CLMM-shaped Aftermath venue");
  const list = example("presale-list") as { presales: Record<string, unknown>[] };
  assert.equal(validator.validate("presale-list", { ...list, presales: [{ ...list.presales[0], venue: aftermath }] }).valid, true);
  assertInvalid("presale-list", { ...list, presales: [{ ...list.presales[0], venue: { kind: "aftermath", pool_id: null } }] }, "a summary Aftermath venue without its vendor");
});

test("Retry-After goes with every 503, rate_limited, and budget_exceeded, and nothing else (CL-23)", () => {
  for (const [code, { status, retryAfter }] of Object.entries(PRESALE_ERRORS)) {
    const expected = status === 503 || code === "rate_limited" || code === "budget_exceeded";
    assert.equal(retryAfter, expected, `${code} retryAfter`);
    const schema = JSON.parse(readFileSync(new URL(`./schemas/errors/${code}.schema.json`, import.meta.url), "utf8")) as {
      description: string;
    };
    assert.ok(schema.description.startsWith(`HTTP ${status}`), `${code} description names its status`);
    assert.equal(schema.description.includes("Retry-After"), expected, `${code} description and Retry-After`);
  }
  const limited = example("errors/rate_limited") as { error: Record<string, unknown> };
  assertInvalid("errors/rate_limited", { error: { ...limited.error, retryAfterSeconds: 5 } }, "a body retryAfterSeconds");
});

test("the route error lists follow CL-18, CL-21, and CL-22", () => {
  const routes = PRESALE_ROUTES as Record<string, { errors: readonly string[]; query?: readonly string[] }>;
  assert.ok(routes["GET /api/presale/bridge/transfers/{id}"].errors.includes("not_found"), "CL-18");
  for (const [route, { errors, query }] of Object.entries(routes)) {
    if (!route.includes(" /api/")) continue;
    if (route.includes("{") || (query ?? []).length > 0) {
      assert.ok(errors.includes("invalid_parameter"), `${route}: invalid_parameter (CL-21)`);
    }
  }
  assert.deepEqual(routes["GET /api/presale/presales/{presale_id}/proof"].query, ["wallet"]);
  assert.ok(!routes["POST /api/presale/outcomes"].errors.includes("unauthorized"), "CL-22");
  assert.ok(!routes["POST /api/presale/outcomes/commitments"].errors.includes("unauthorized"), "CL-22");
});

test("a destructured parse works (Q-004)", () => {
  const { parse, validate } = createPresaleValidator();
  assert.deepEqual(parse("presale-list", PRESALE_EXAMPLES["presale-list"]), PRESALE_EXAMPLES["presale-list"]);
  assert.equal(validate("presale-list", {}).valid, false);
  assert.throws(() => parse("presale-list", {}), TypeError);
});

test("the section 7 clarifications are enforced", () => {
  const dryRun = example("errors/dry_run_failed") as { error: Record<string, unknown> };
  assertInvalid("errors/dry_run_failed", { error: { ...dryRun.error, move_abort: "ENotAnAbort" } }, "an unknown abort");
  assertInvalid("errors/dry_run_failed", { error: { ...dryRun.error, move_abort: null } }, "a null abort without a reason");
  assertValid("errors/dry_run_failed", {
    error: { code: "dry_run_failed", message: "Too costly.", move_abort: null, reason: "gas_cap_exceeded" },
  });
  assertValid("errors/dry_run_failed", {
    error: { code: "dry_run_failed", message: "A swap aborted.", move_abort: null, reason: "external_abort" },
  });
  assertInvalid(
    "errors/dry_run_failed",
    { error: { ...dryRun.error, reason: "external_abort" } },
    "a named presale abort with external_abort (CL-19)",
  );

  // CL-25: budget_exceeded says which budget is exceeded.
  for (const reason of ["daily_limit", "open_reservations"]) {
    assertValid("errors/budget_exceeded", { error: { code: "budget_exceeded", message: "Used up.", reason } });
  }
  assertInvalid("errors/budget_exceeded", { error: { code: "budget_exceeded", message: "Used up." } }, "budget_exceeded without a reason");
  assertInvalid("errors/budget_exceeded", { error: { code: "budget_exceeded", message: "Used up.", reason: "hourly_limit" } }, "an unknown budget");

  const allowlist = example("allowlist-response");
  assertInvalid("allowlist-response", { ...allowlist, root: `0x${allowlist.root}` }, "a 0x root (CL-15)");
  assertInvalid("allowlist-response", { ...allowlist, leaf_count: 3 }, "a JSON-number u64 (CL-11)");
  const proof = example("allowlist-proof-response") as { proof: string[] };
  assertInvalid("allowlist-proof-response", { ...proof, proof: [`0x${proof.proof[0]}`] }, "a 0x proof entry");

  const settings = example("account-settings-response");
  assertInvalid("account-settings-response", { explorer: settings.explorer, theme: settings.theme }, "no saved (CL-8)");
  assertInvalid("account-settings-request", { ...example("account-settings-request"), saved: true }, "saved in a PUT");

  const quote = example("bridge-quote-response") as { standard: Record<string, unknown> };
  assertValid("bridge-quote-response", { ...quote, standard: { ...quote.standard, fee_bps: "1.3" } });
  assertInvalid("bridge-quote-response", { ...quote, standard: { ...quote.standard, fee_bps: 1.3 } }, "a number fee_bps");

  const unconfirmed = example("errors/execution_unconfirmed") as { error: Record<string, unknown> };
  delete unconfirmed.error.digest;
  assertInvalid("errors/execution_unconfirmed", unconfirmed, "no error.digest (CL-10)");

  const sponsor = example("sponsor-response");
  assertInvalid("sponsor-response", { ...sponsor, sponsor_signature: "AAAA" }, "a sponsor signature (CA-7)");

  const lifecycle = example("ws-presale-lifecycle") as { projection: Record<string, unknown> };
  lifecycle.projection = { lifecycle: lifecycle.projection.lifecycle, totals: lifecycle.projection.totals };
  assertInvalid("ws-presale-lifecycle", lifecycle, "a projection delta (CL-4)");

  // CL-20: only snapshot carries topic.
  const snapshot = example("ws-presale-snapshot");
  delete snapshot.topic;
  assertInvalid("ws-presale-snapshot", snapshot, "a snapshot without topic (CL-20)");
  for (const name of [
    "ws-presale-committed",
    "ws-presale-lifecycle",
    "ws-presale-claimed",
    "ws-presale-created",
    "ws-presale-opened",
  ] as const) {
    assert.equal(Object.hasOwn(example(name), "topic"), false, `${name} example has topic`);
    assertInvalid(name, { ...example(name), topic: "presale_feed" }, "a log message with topic (CL-20)");
  }
});

test("a replayed message carries replayed: true, and a replayed lifecycle may omit its projection (CL-26)", () => {
  const logMessages = [
    "ws-presale-committed",
    "ws-presale-lifecycle",
    "ws-presale-claimed",
    "ws-presale-created",
    "ws-presale-opened",
  ] as const;
  for (const name of logMessages) {
    assertValid(name, { ...example(name), replayed: true });
    assertInvalid(name, { ...example(name), replayed: false }, "replayed: false");
  }
  assertInvalid("ws-presale-snapshot", { ...example("ws-presale-snapshot"), replayed: true }, "a replayed snapshot");

  const lifecycle = example("ws-presale-lifecycle");
  delete lifecycle.projection;
  assertInvalid("ws-presale-lifecycle", lifecycle, "a live lifecycle without its projection");
  assertValid("ws-presale-lifecycle", { ...lifecycle, replayed: true });
  assert.ok(
    (PRESALE_VARIANTS["ws-presale-lifecycle"] ?? []).some(
      (variant) => (variant as { replayed?: boolean }).replayed === true && !Object.hasOwn(variant as object, "projection"),
    ),
    "a typed replayed lifecycle variant",
  );
});

test("a sale topic gets a snapshot or a snapshot_unavailable, never both missing (CL-28)", () => {
  assert.equal(PRESALE_TOPICS["presale:<presale_id>"].messages.snapshot_unavailable, "ws-presale-snapshot-unavailable");
  const unavailable = example("ws-presale-snapshot-unavailable");
  assertValid("ws-presale-snapshot-unavailable", { ...unavailable, reason: "not_found" });
  assertValid("ws-presale-snapshot-unavailable", { ...unavailable, reason: "unavailable" });
  assertInvalid("ws-presale-snapshot-unavailable", { ...unavailable, reason: "archived" }, "another reason");
  assertInvalid("ws-presale-snapshot-unavailable", { ...unavailable, topic: "presale_feed" }, "the feed topic");
  assertInvalid("ws-presale-snapshot-unavailable", { ...unavailable, cursor: "1:1:0:0" }, "a cursor");
});

test("claimed carries the sale's totals, as committed does (CL-29)", () => {
  assert.ok(validator.requiredFields("ws-presale-claimed").includes("totals"));
  const claimed = example("ws-presale-claimed") as { totals: Record<string, unknown> };
  assert.deepEqual(Object.keys(claimed.totals).sort(), Object.keys(example("ws-presale-committed").totals as object).sort());
  assertInvalid("ws-presale-claimed", { ...claimed, totals: { remaining_commitments: "0" } }, "partial totals");
});

test("the presale exposes its hard-cap window and CLMM migration witness", () => {
  const projection = example("presale-projection") as Record<string, unknown> & { uncapped: Record<string, unknown>; windows: Record<string, unknown> };
  assert.deepEqual(projection.hard_cap, { starts_after_ms: 72_000_000, closes_when_filled: false });
  assertInvalid("presale-projection", { ...projection, uncapped: { ...projection.uncapped, hard_cap: true } }, "generation 1's uncapped hard_cap");
  assertInvalid("presale-projection", { ...projection, hard_cap: true }, "a boolean hard cap");
  assertInvalid("presale-projection", { ...projection, hard_cap: { starts_after_ms: 0 } }, "a hard cap without closes_when_filled");
  const { hard_cap_from_ms: _from, ...withoutFrom } = projection.windows;
  void _from;
  assertInvalid("presale-projection", { ...projection, windows: withoutFrom }, "windows without hard_cap_from_ms");
  assert.equal(validator.validate("presale-projection", { ...projection, hard_cap: null, windows: { ...projection.windows, hard_cap_from_ms: null } }).valid, true);
  assertValid("presale-projection", { ...projection, venue: { kind: "bluefin", venue: `0x${"ab".repeat(32)}::bluefin::Venue` } });
  assertInvalid("presale-projection", { ...projection, venue: { kind: "bluefin", tick_spacing: 60, pool_fee_rate: "3000" } }, "a retired venue shape");
});

test("presale fee routing requires the published destination variants", () => {
  const projection = example("presale-projection");
  for (const destination of [{ kind: "address" }, { kind: "owner", address: "0x1" }, { kind: "protocol" }]) {
    assertInvalid("presale-projection", {
      ...projection,
      fee_split: { routes: [{ destination, bps: "10000" }] },
    }, `destination ${JSON.stringify(destination)}`);
  }
});
