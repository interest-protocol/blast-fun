import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  blankDraft,
  parseDraft,
} from "@blast/core/modules/social/create/model.ts";
import { vestingTerms } from "@blast/core/modules/social/create/presale-args.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import {
  VESTING_UNITS,
  vestingDurationMs,
} from "../../../packages/core/src/modules/social/contracts/vesting.ts";
import {
  normalizeRecipientDraftV1,
  RecipientDraftNormalizationError,
} from "./normalize.ts";

// Frozen pre-retirement interpretation: months are fixed 30-day periods;
// this oracle never asks the runtime parser to accept an old recipient shape.
const OLD = Object.freeze({
  label: "  Team  ",
  address: "0xhalf",
  bps: 6500,
  vest: true,
  cliff_months: 3,
  months: 12,
});
const EXPECTED = Object.freeze({
  label: "  Team  ",
  address: "0xhalf",
  bps: 6500,
  vest: true,
  cliff: 3,
  duration: 12,
  cliff_unit: "months",
  duration_unit: "months",
});
const MONTH_MS = 2_592_000_000n;

function draft(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...blankDraft(),
    token_recipients: [OLD],
    raise_recipients: [OLD],
    ...overrides,
  };
}

function freezeDeep(value: unknown): void {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
}

function refuses(body: unknown, field: string) {
  assert.throws(
    () => normalizeRecipientDraftV1(body),
    (error) => {
      assert.ok(error instanceof RecipientDraftNormalizationError);
      assert.equal(error.code, "recipient_draft_v1_invalid");
      assert.equal(error.field, field);
      assert.doesNotMatch(error.message, /private-marker|sensitive/);
      assert.equal(Object.hasOwn(error, "cause"), false);
      return true;
    },
  );
}

test("normalizes both recipient arrays without mutation and retains unrelated raw fields", () => {
  const body = draft({
    name: "",
    tagline: "  unfinished  ",
    quote_type: undefined,
  });
  delete body.quote_type;
  const raw = JSON.stringify(body);
  freezeDeep(body);
  const result = normalizeRecipientDraftV1(body);
  assert.equal(result.changedRecipients, 2);
  assert.deepEqual(result.body.token_recipients, [EXPECTED]);
  assert.deepEqual(result.body.raise_recipients, [EXPECTED]);
  assert.equal(JSON.stringify(body), raw);
  for (const key of Object.keys(body).filter(
    (key) => !["token_recipients", "raise_recipients"].includes(key),
  )) {
    assert.equal(result.body[key], body[key as keyof typeof body], key);
  }
  assert.equal(
    Object.hasOwn(result.body, "quote_type"),
    false,
    "validation must not fill unrelated defaults",
  );
});

test("canonical rows, explicit units, omitted units and an entirely canonical body remain identical", () => {
  const canonical = {
    ...EXPECTED,
    cliff_unit: "weeks",
    duration_unit: "minutes",
  };
  const unitless = {
    label: "",
    address: "",
    bps: 0,
    vest: false,
    cliff: 0,
    duration: 0,
  };
  const body = draft({
    token_recipients: [canonical, unitless],
    raise_recipients: [],
  });
  const result = normalizeRecipientDraftV1(body);
  assert.equal(result.changedRecipients, 0);
  assert.equal(result.body, body);
  assert.equal((result.body.token_recipients as unknown[])[0], canonical);
  assert.equal((result.body.token_recipients as unknown[])[1], unitless);
  assert.equal(Object.hasOwn(unitless, "cliff_unit"), false);
});

test("mixed arrays retain count, order, allocation and canonical row identity; normalization is idempotent", () => {
  const canonical = { ...EXPECTED, label: "canonical", cliff_unit: "days" };
  const body = draft({
    token_recipients: [canonical, OLD, { ...OLD, label: "last", bps: 0 }],
    raise_recipients: [],
  });
  const first = normalizeRecipientDraftV1(body);
  const rows = first.body.token_recipients as Record<string, unknown>[];
  assert.deepEqual(
    rows.map((row) => [row.label, row.bps]),
    [
      ["canonical", 6500],
      ["  Team  ", 6500],
      ["last", 0],
    ],
  );
  assert.equal(rows[0], canonical);
  const second = normalizeRecipientDraftV1(first.body);
  assert.equal(second.changedRecipients, 0);
  assert.equal(second.body, first.body);
});

test("incomplete and disabled schedules retain zero and maximum safe integer values", () => {
  const old = {
    ...OLD,
    label: "",
    address: "",
    bps: 0,
    vest: false,
    cliff_months: Number.MAX_SAFE_INTEGER,
    months: 0,
  };
  const result = normalizeRecipientDraftV1(
    draft({ token_recipients: [old], raise_recipients: [] }),
  );
  assert.deepEqual(result.body.token_recipients, [
    {
      label: "",
      address: "",
      bps: 0,
      vest: false,
      cliff: Number.MAX_SAFE_INTEGER,
      duration: 0,
      cliff_unit: "months",
      duration_unit: "months",
    },
  ]);
  const parsed = parseDraft(result.body).token_recipients[0]!;
  assert.equal(
    BigInt(parsed.cliff) * MONTH_MS,
    23_346_660_468_288_648_672_000_000n,
  );
});

test("canonical parse and SDK vesting match frozen old 30-day semantics", () => {
  const parsed = parseDraft(normalizeRecipientDraftV1(draft()).body);
  assert.deepEqual(parsed.token_recipients, [EXPECTED]);
  assert.deepEqual(parsed.raise_recipients, [EXPECTED]);
  assert.deepEqual(vestingTerms(EXPECTED.cliff, EXPECTED.duration), {
    cliffDelayMs: 3n * MONTH_MS,
    periodDurationMs: 86_400_000n,
    periods: 360n,
  });
});

test("every canonical unit retains raw identity and its fixed millisecond meaning", () => {
  const milliseconds = [
    2_592_000_000n,
    604_800_000n,
    86_400_000n,
    3_600_000n,
    60_000n,
    1_000n,
    1n,
  ];
  for (const [index, unit] of VESTING_UNITS.entries()) {
    const row = { ...EXPECTED, cliff_unit: unit, duration_unit: unit };
    const result = normalizeRecipientDraftV1(
      draft({ token_recipients: [row], raise_recipients: [OLD] }),
    );
    assert.equal((result.body.token_recipients as unknown[])[0], row);
    const parsed = parseDraft(result.body).token_recipients[0]!;
    assert.equal(
      vestingDurationMs(parsed.cliff, parsed.cliff_unit!),
      3n * milliseconds[index]!,
    );
    assert.equal(
      vestingDurationMs(parsed.duration, parsed.duration_unit!),
      12n * milliseconds[index]!,
    );
  }
});

test("TEST_SUI quote and all raw amount/fee/allowlist fields survive without defaults or repricing", () => {
  const body = {
    ...blankDraft(CREATE_TEST_SUI_QUOTE_TYPE),
    token_recipients: [OLD],
    raise_recipients: [OLD],
  };
  const result = normalizeRecipientDraftV1(body);
  for (const key of Object.keys(body).filter(
    (key) => !key.endsWith("_recipients") || key === "fee_recipients",
  )) {
    assert.equal(result.body[key], body[key as keyof typeof body], key);
  }
  assert.equal(parseDraft(result.body).quote_type, CREATE_TEST_SUI_QUOTE_TYPE);
});

test("empty arrays and the maximum 64 rows remain supported without truncation", () => {
  assert.equal(
    normalizeRecipientDraftV1(
      draft({ token_recipients: [], raise_recipients: [] }),
    ).changedRecipients,
    0,
  );
  const rows = Array.from({ length: 64 }, (_, index) => ({
    ...OLD,
    bps: index,
  }));
  const result = normalizeRecipientDraftV1(
    draft({ token_recipients: rows, raise_recipients: rows }),
  );
  assert.equal(result.changedRecipients, 128);
  assert.deepEqual(
    (result.body.token_recipients as Record<string, unknown>[]).map(
      (row) => row.bps,
    ),
    rows.map((row) => row.bps),
  );
  refuses(draft({ token_recipients: [...rows, OLD] }), "token_recipients");
});

test("ambiguous old/new fields, unknown fields and missing old counterparts refuse atomically", () => {
  for (const row of [
    { ...OLD, cliff: 3 },
    { ...OLD, duration: 12 },
    { ...OLD, cliff_unit: "months" },
    { ...OLD, sensitive: "private-marker" },
  ]) {
    const body = draft({ token_recipients: [EXPECTED, row] });
    const before = JSON.stringify(body);
    refuses(body, "token_recipients.1");
    assert.equal(JSON.stringify(body), before);
  }
  const missing = { label: OLD.label, address: OLD.address, bps: OLD.bps, vest: OLD.vest, cliff_months: OLD.cliff_months };
  refuses(draft({ raise_recipients: [missing] }), "raise_recipients.0");
});

test("invalid scalar types and out-of-range schedules fail with sanitized field-only diagnostics", () => {
  for (const value of [
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "private-marker",
    null,
  ]) {
    refuses(
      draft({ token_recipients: [{ ...OLD, cliff_months: value }] }),
      "token_recipients.0.cliff",
    );
    refuses(
      draft({ raise_recipients: [{ ...OLD, months: value }] }),
      "raise_recipients.0.duration",
    );
  }
  const max = normalizeRecipientDraftV1(
    draft({ token_recipients: [{ ...OLD, months: Number.MAX_SAFE_INTEGER }] }),
  );
  assert.equal(
    parseDraft(max.body).token_recipients[0]!.duration,
    Number.MAX_SAFE_INTEGER,
  );
  refuses(
    draft({ raise_recipients: [{ ...OLD, vest: "private-marker" }] }),
    "raise_recipients.0.vest",
  );
  refuses(
    draft({ raise_recipients: [{ ...OLD, bps: -1 }] }),
    "raise_recipients.0.bps",
  );
});

test("invalid canonical rows and malformed arrays are refused, never replaced by defaults", () => {
  refuses(
    draft({ token_recipients: [{ ...EXPECTED, duration_unit: "centuries" }] }),
    "token_recipients.0.duration_unit",
  );
  for (const value of [null, {}, "private-marker", new Array(1)])
    refuses(draft({ raise_recipients: value }), "raise_recipients");
  refuses(draft({ token_recipients: [null] }), "token_recipients.0");
  refuses(null, "draft");
  refuses(draft({ symbol: "private-marker" }), "symbol");
  refuses(
    draft({ token_recipients: [{ ...EXPECTED, sensitive: "private-marker" }] }),
    "token_recipients.0",
  );
  const root = draft();
  Object.defineProperty(root, "symbol", {
    get() {
      throw new Error("private-marker");
    },
  });
  refuses(root, "draft");
});

test("record metadata outside body stays untouched and is not smuggled into the normalized body", () => {
  const record = Object.freeze({
    draft_id: "draft-private-marker",
    account_id: "account-private-marker",
    version: 17,
    updated_at: "unchanged",
    body: draft(),
  });
  const result = normalizeRecipientDraftV1(record.body);
  assert.deepEqual(
    [record.draft_id, record.account_id, record.version, record.updated_at],
    ["draft-private-marker", "account-private-marker", 17, "unchanged"],
  );
  for (const key of ["draft_id", "account_id", "version", "updated_at"])
    assert.equal(Object.hasOwn(result.body, key), false);
  refuses(record, "draft");
});

test("versioned migration tool has no production source import or export edges", () => {
  const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  let inspected = 0;
  function scan(path: string): void {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const entry = resolve(path, item.name);
      if (item.isDirectory()) scan(entry);
      else if (/\.(?:ts|tsx|js|mjs)$/.test(item.name)) {
        inspected++;
        const text = readFileSync(entry, "utf8");
        assert.doesNotMatch(
          text,
          /recipient-draft-v1|normalizeRecipientDraftV1/,
          entry,
        );
        if (!/\.test\.[cm]?[jt]sx?$/.test(item.name)) {
          assert.doesNotMatch(text, /\bcliff_months\b/, entry);
        }
      }
    }
  }
  for (const relative of [
    "apps/web/src",
    "apps/backend-api/src",
    "apps/workers/src",
    "packages/core/src",
    "packages/server/src",
  ])
    scan(resolve(root, relative));
  assert.ok(inspected > 2000);
});
