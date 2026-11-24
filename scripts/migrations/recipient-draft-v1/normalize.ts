import { CREATE_MAX_RECIPIENTS } from "@blast/core/modules/social/contracts/create.ts";
import {
  DraftShapeError,
  parseDraft,
} from "@blast/core/modules/social/create/model.ts";

const OLD_KEYS = [
  "label",
  "address",
  "bps",
  "vest",
  "cliff_months",
  "months",
] as const;
const CURRENT_KEYS = [
  "label",
  "address",
  "bps",
  "vest",
  "cliff",
  "duration",
] as const;
const UNIT_KEYS = ["cliff_unit", "duration_unit"] as const;

/** Offline migration preparation only. Never import from runtime handlers or browser code. */
export class RecipientDraftNormalizationError extends Error {
  readonly code = "recipient_draft_v1_invalid";
  readonly field: string;

  constructor(field: string) {
    super(`Cannot normalize recipient draft: ${field}.`);
    this.name = "RecipientDraftNormalizationError";
    this.field = field;
  }
}

export type RecipientDraftNormalization = Readonly<{
  body: Readonly<Record<string, unknown>>;
  changedRecipients: number;
}>;

export function normalizeRecipientDraftV1(
  body: unknown,
): RecipientDraftNormalization {
  const raw = plainRecord(body, "draft");
  if (
    !Object.hasOwn(raw, "token_recipients") ||
    !Object.hasOwn(raw, "raise_recipients")
  ) {
    throw new RecipientDraftNormalizationError("draft");
  }
  const tokens = normalizeRecipients(raw.token_recipients, "token_recipients");
  const raise = normalizeRecipients(raw.raise_recipients, "raise_recipients");
  const changedRecipients = tokens.changed + raise.changed;
  const normalized =
    changedRecipients === 0
      ? raw
      : { ...raw, token_recipients: tokens.rows, raise_recipients: raise.rows };
  validateCanonicalBody(normalized);
  return { body: normalized, changedRecipients };
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new RecipientDraftNormalizationError(field);
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    (prototype !== null && prototype !== Object.prototype) ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key], "value"),
    )
  ) {
    throw new RecipientDraftNormalizationError(field);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  row: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  if (
    !required.every((key) => Object.hasOwn(row, key)) ||
    !Object.keys(row).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  ) {
    throw new RecipientDraftNormalizationError(field);
  }
}

function normalizeRecipients(
  value: unknown,
  field: string,
): { rows: unknown[]; changed: number } {
  if (
    !Array.isArray(value) ||
    value.length > CREATE_MAX_RECIPIENTS ||
    Object.keys(value).length !== value.length ||
    Array.from({ length: value.length }, (_, index) => index).some(
      (index) => !Object.hasOwn(value, index),
    )
  ) {
    throw new RecipientDraftNormalizationError(field);
  }
  let changed = 0;
  const rows = value.map((entry, index) => {
    const rowField = `${field}.${index}`;
    const row = plainRecord(entry, rowField);
    if (!Object.hasOwn(row, "cliff_months") && !Object.hasOwn(row, "months")) {
      exactKeys(row, CURRENT_KEYS, UNIT_KEYS, rowField);
      return entry;
    }
    exactKeys(row, OLD_KEYS, [], rowField);
    changed++;
    return {
      label: row.label,
      address: row.address,
      bps: row.bps,
      vest: row.vest,
      cliff: row.cliff_months,
      duration: row.months,
      cliff_unit: "months",
      duration_unit: "months",
    };
  });
  return { rows: changed === 0 ? value : rows, changed };
}

function validateCanonicalBody(body: Record<string, unknown>): void {
  try {
    // Validation only: returning parseDraft's result would fill defaults and rewrite unrelated fields.
    parseDraft(body);
  } catch (error) {
    const field =
      error instanceof DraftShapeError &&
      /^[a-z_]+(?:\.(?:[a-z_]+|\d+))*$/.test(error.field)
        ? error.field
        : "draft";
    throw new RecipientDraftNormalizationError(field);
  }
}
