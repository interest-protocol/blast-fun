import { readFileSync } from "node:fs";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import { PRESALE_SCHEMA_ID_BASE, presaleSchemaFiles } from "./validate.ts";

/**
 * Test support for Q-001 and Q-009: which branches of the presale schemas a
 * set of payloads reaches. A branch is an `anyOf`/`oneOf` alternative or a
 * member of a multi-value `enum`. A typed example or variant that reaches every
 * branch means every branch of every schema is checked against a value
 * TypeScript accepted, so a type and its schema cannot drift on a branch no
 * test exercises.
 *
 * The enums tied to SDK types are exempt: the contract test checks them
 * against the SDK lists instead (`lifecycle`, `venue_kind`, `eligibility_kind`,
 * and the `presale_abort_name` values).
 */

type Schema = boolean | { [keyword: string]: unknown };
const BRANCH_KEYWORDS = ["anyOf", "oneOf"] as const;
const SDK_TIED_ENUMS = ["lifecycle", "venue_kind", "eligibility_kind", "presale_abort_name"].map(
  (name) => `${PRESALE_SCHEMA_ID_BASE}defs.schema.json#/$defs/${name}/enum`,
);

/** A multi-value `enum` whose members are branches. */
function isBranchEnum(uri: string, values: unknown): values is unknown[] {
  return Array.isArray(values) && values.length > 1 && !SDK_TIED_ENUMS.includes(uri);
}

function load(): Map<string, Schema> {
  const documents = new Map<string, Schema>();
  for (const name of ["defs", ...presaleSchemaFiles()]) {
    const text = readFileSync(new URL(`./schemas/${name}.schema.json`, import.meta.url), "utf8");
    documents.set(`${PRESALE_SCHEMA_ID_BASE}${name}.schema.json`, JSON.parse(text) as Schema);
  }
  return documents;
}

/** `uri` is `<document $id>#<JSON pointer>`. */
function child(uri: string, ...segments: (string | number)[]): string {
  return `${uri}/${segments.join("/")}`;
}

export function createBranchCoverage() {
  const documents = load();
  const ajv = new Ajv2020({ allErrors: false, strict: true });
  for (const schema of documents.values()) ajv.addSchema(schema as object);
  const checks = new Map<string, ValidateFunction>();

  function at(uri: string): Schema {
    const [document, pointer = ""] = uri.split("#");
    let node: unknown = documents.get(document);
    if (node === undefined) throw new Error(`no schema ${document}`);
    for (const segment of pointer.split("/").slice(1)) node = (node as Record<string, unknown>)[segment];
    if (node === undefined) throw new Error(`no schema at ${uri}`);
    return node as Schema;
  }

  function matches(uri: string, value: unknown): boolean {
    let check = checks.get(uri);
    if (!check) {
      check = ajv.compile({ $ref: uri });
      checks.set(uri, check);
    }
    return check(value) === true;
  }

  /** Every branch in every schema file: each `anyOf`/`oneOf` alternative and each member of a branch enum. */
  function alternatives(): string[] {
    const found: string[] = [];
    const walk = (node: unknown, uri: string) => {
      if (Array.isArray(node)) return node.forEach((item, index) => walk(item, child(uri, index)));
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        const branches =
          ((BRANCH_KEYWORDS as readonly string[]).includes(key) && Array.isArray(value)) ||
          (key === "enum" && isBranchEnum(child(uri, key), value));
        if (branches) (value as unknown[]).forEach((_, index) => found.push(child(uri, key, index)));
        if (key !== "enum") walk(value, child(uri, key));
      }
    };
    for (const [id, schema] of documents) walk(schema, `${id}#`);
    return found;
  }

  /** Adds to `reached` every branch `value` matches, under the schema at `uri`. */
  function visit(uri: string, value: unknown, reached: Set<string>): void {
    const node = at(uri);
    if (typeof node !== "object") return;
    // Enum members are JSON primitives here, so strict equality is deep equality.
    if (isBranchEnum(child(uri, "enum"), node.enum)) {
      const index = node.enum.indexOf(value);
      if (index >= 0) reached.add(child(uri, "enum", index));
    }
    if (typeof node.$ref === "string") {
      const target = new URL(node.$ref, uri).href;
      visit(target.includes("#") ? target : `${target}#`, value, reached);
    }
    for (const keyword of BRANCH_KEYWORDS) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      branches.forEach((_, index) => {
        const branch = child(uri, keyword, index);
        if (!matches(branch, value)) return;
        reached.add(branch);
        visit(branch, value, reached);
      });
    }
    visitProperties(node, uri, value, reached);
    if (node.items !== undefined && Array.isArray(value)) {
      for (const item of value) visit(child(uri, "items"), item, reached);
    }
  }

  function visitProperties(node: Exclude<Schema, boolean>, uri: string, value: unknown, reached: Set<string>): void {
    const properties = node.properties as Record<string, unknown> | undefined;
    if (properties && typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) visit(child(uri, "properties", key), item, reached);
      }
    }
  }

  return {
    alternatives,
    /** The branches `value`, a `name` payload, reaches. */
    reached(name: string, value: unknown, into = new Set<string>()): Set<string> {
      visit(`${PRESALE_SCHEMA_ID_BASE}${name}.schema.json#`, value, into);
      return into;
    },
  };
}
