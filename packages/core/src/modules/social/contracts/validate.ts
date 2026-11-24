import { readFileSync } from "node:fs";

import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";

import { SOCIAL_SCHEMA_NAMES } from "./schemas/schema-names.generated.ts";

/**
 * Validates social payloads against the published JSON Schemas (draft
 * 2020-12) in `schemas/`. Node only: it reads the schema files from disk, for
 * route tests and tooling. `ajv` is a development dependency; do not import
 * this from application code.
 */

const SCHEMA_ROOT = new URL("./schemas/", import.meta.url);
export const SOCIAL_SCHEMA_ID_BASE = "https://blast-v2.invalid/social/contracts/";
const SUFFIX = ".schema.json";

export type SocialSchemaName = (typeof SOCIAL_SCHEMA_NAMES)[number];

export function socialSchemaFiles(): string[] {
  return [...SOCIAL_SCHEMA_NAMES];
}

export function createSocialValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const name of socialSchemaFiles()) {
    const schema = JSON.parse(readFileSync(new URL(`${name}${SUFFIX}`, SCHEMA_ROOT), "utf8")) as { $id?: string };
    if (schema.$id !== `${SOCIAL_SCHEMA_ID_BASE}${name}${SUFFIX}`) throw new Error(`${name}: $id must name its path`);
    ajv.addSchema(schema);
  }
  return {
    validate(name: SocialSchemaName, value: unknown): { valid: boolean; errors: ErrorObject[] } {
      const check = ajv.getSchema(`${SOCIAL_SCHEMA_ID_BASE}${name}${SUFFIX}`);
      if (!check) throw new Error(`Unknown social schema ${name}.`);
      const valid = check(value) as boolean;
      return { valid, errors: valid ? [] : [...(check.errors ?? [])] };
    },
  };
}
