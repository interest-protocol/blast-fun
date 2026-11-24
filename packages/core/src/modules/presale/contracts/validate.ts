import { readFileSync, readdirSync } from "node:fs";

import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";

import type { PresaleSchemaName, PresaleSchemaTypes } from "./routes.ts";

/**
 * Validates presale payloads against the published JSON Schemas (draft
 * 2020-12) in `schemas/`. Node only: it reads the schema files from disk, for
 * route tests, the mock client's fixture build, and other tooling. `ajv` is a
 * development dependency; do not import this from application code.
 */

const SCHEMA_ROOT = new URL("./schemas/", import.meta.url);
/** Every schema's `$id` is this base plus its path under `schemas/`. */
export const PRESALE_SCHEMA_ID_BASE = "https://blast-v2.invalid/presale/contracts/";
const SUFFIX = ".schema.json";
/** Shared definitions; not a payload. */
const DEFS = "defs";

type JsonSchema = {
  $id?: string;
  $ref?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  enum?: unknown[];
  $defs?: Record<string, JsonSchema>;
};

function schemaPaths(directory: URL, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return schemaPaths(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
    return entry.name.endsWith(SUFFIX) ? [`${prefix}${entry.name.slice(0, -SUFFIX.length)}`] : [];
  });
}

/** The payload schema names on disk (every schema file except the shared definitions). */
export function presaleSchemaFiles(): string[] {
  return schemaPaths(SCHEMA_ROOT).filter((name) => name !== DEFS);
}

function readSchema(name: string): JsonSchema {
  return JSON.parse(readFileSync(new URL(`${name}${SUFFIX}`, SCHEMA_ROOT), "utf8")) as JsonSchema;
}

export type PresaleValidation = { valid: boolean; errors: ErrorObject[] };

export function createPresaleValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schemas = new Map<string, JsonSchema>();
  for (const name of [DEFS, ...presaleSchemaFiles()]) {
    const schema = readSchema(name);
    if (schema.$id !== `${PRESALE_SCHEMA_ID_BASE}${name}${SUFFIX}`) throw new Error(`${name}: $id must name its path`);
    schemas.set(name, schema);
    ajv.addSchema(schema);
  }
  const definitions = schemas.get(DEFS)?.$defs ?? {};

  function definition(name: string): JsonSchema {
    const found = definitions[name];
    if (!found) throw new Error(`no definition ${name}`);
    return found;
  }

  /** A `$ref` to a shared definition, resolved one level. */
  function referenced(schema: JsonSchema): JsonSchema | null {
    const match = schema.$ref?.match(/defs\.schema\.json#\/\$defs\/(.+)$/);
    return match ? definition(match[1]) : null;
  }

  /** Whether `value` is a valid `name` payload, with every violation. */
  function validate(name: PresaleSchemaName, value: unknown): PresaleValidation {
    const check = ajv.getSchema(`${PRESALE_SCHEMA_ID_BASE}${name}${SUFFIX}`);
    if (!check) throw new Error(`no schema ${name}`);
    // Every presale schema is synchronous.
    const valid = check(value) === true;
    return { valid, errors: valid ? [] : [...(check.errors ?? [])] };
  }

  /** `value` as a `name` payload, or a thrown error listing every violation. */
  function parse<Name extends PresaleSchemaName>(name: Name, value: unknown): PresaleSchemaTypes[Name] {
    const result = validate(name, value);
    if (!result.valid) throw new TypeError(`invalid ${name}: ${ajv.errorsText(result.errors)}`);
    return value as PresaleSchemaTypes[Name];
  }

  // Plain functions, not methods: a destructured `validate` or `parse` works.
  return {
    validate,
    parse,
    /** The payload's required top-level fields, including those of a shared definition it extends. */
    requiredFields(name: PresaleSchemaName): string[] {
      const schema = schemas.get(name);
      if (!schema) throw new Error(`no schema ${name}`);
      return [...new Set([...(schema.required ?? []), ...(referenced(schema)?.required ?? [])])];
    },
    /** The fields a shared definition lists. */
    definitionFields(name: string): string[] {
      return Object.keys(definition(name).properties ?? {});
    },
    /** The values a shared enumeration allows. */
    definitionEnum(name: string): unknown[] {
      return [...(definition(name).enum ?? [])];
    },
  };
}

export type PresaleValidator = ReturnType<typeof createPresaleValidator>;
