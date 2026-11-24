import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { V1_UNPUBLISHED } from "@blast/server/modules/partner-api/v1/presales.ts";

/**
 * The partner v1 presale reads are the social ones less the v1 adapter's fields. Here the social
 * schemas, with those fields removed, must publish exactly the properties of the pinned published
 * contract at every level (through every `$ref`, across files, and every object branch of a
 * `oneOf`), so a field added to a social presale read fails this test instead of the deploy's live
 * gate (blast-v2#566). A `$ref` that does not resolve fails it too.
 */
type Schema = Record<string, unknown>;
type Located = Readonly<{ schema: Schema; root: Schema }>;

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Schema;
const contract = read("../../scripts/partner-api-live/contract.json");
const pinned = (contract.components as { schemas: Record<string, Schema> }).schemas;
const SOCIAL_ID = "https://blast-v2.invalid/social/contracts/";
const socialFile = (name: string) => read(`../../../../packages/core/src/modules/social/contracts/schemas/${name}`);
const social = (name: string): Located => {
  const schema = socialFile(`${name}.schema.json`);
  return { schema, root: schema };
};

/** `schema` with every `$ref` followed, in its own file, another social file or the contract. */
function located(schema: unknown, root: Schema, path: string): Located {
  let current = schema as Schema;
  let base = root;
  while (typeof current?.$ref === "string") {
    const ref = current.$ref;
    if (ref.startsWith("#/$defs/")) current = (base.$defs as Record<string, Schema> | undefined)?.[ref.slice(8)] as Schema;
    else if (ref.startsWith("#/components/schemas/")) current = pinned[ref.slice(21)] as Schema;
    else if (ref.startsWith(SOCIAL_ID)) current = base = socialFile(ref.slice(SOCIAL_ID.length));
    else assert.fail(`${path}: a $ref this test cannot follow: ${ref}`);
    assert.ok(current, `${path}: unresolved $ref ${ref}`);
  }
  return { schema: current, root: base };
}

/** The object and array shapes `at` may take: itself, or each such branch of its `oneOf`/`anyOf`. */
function shapes(at: Located, path: string): Located[] {
  const { schema, root } = at;
  const branches = (schema.oneOf ?? schema.anyOf) as unknown[] | undefined;
  if (branches) return branches.flatMap((branch) => shapes(located(branch, root, path), path));
  return schema.properties || schema.items ? [at] : [];
}

/** Every path where the two schemas differ in properties, `drop` naming what the social side loses there. */
function differences(socialAt: Located, v1At: Located, drop: Readonly<Record<string, readonly string[]>>, path: string): string[] {
  const left = shapes(socialAt, path);
  const right = shapes(v1At, path);
  if (left.length !== right.length) return [`${path}: ${left.length} object shapes in social, ${right.length} in v1`];
  return left.flatMap((socialShape, index) => {
    const v1Shape = right[index]!;
    const [s, v] = [socialShape.schema, v1Shape.schema];
    if (s.items || v.items) {
      if (!s.items || !v.items) return [`${path}: an array on one side only`];
      return differences(located(s.items, socialShape.root, path), located(v.items, v1Shape.root, path), drop, `${path}[]`);
    }
    const socialProperties = s.properties as Record<string, unknown>;
    const v1Properties = v.properties as Record<string, unknown>;
    const removed = drop[path] ?? [];
    const socialKeys = Object.keys(socialProperties).filter((key) => !removed.includes(key)).sort();
    const v1Keys = Object.keys(v1Properties).sort();
    const own = JSON.stringify(socialKeys) === JSON.stringify(v1Keys) ? [] : [`${path}: social ${socialKeys.join(",")} / v1 ${v1Keys.join(",")}`];
    return own.concat(socialKeys.filter((key) => v1Keys.includes(key)).flatMap((key) => differences(
      located(socialProperties[key], socialShape.root, `${path}.${key}`),
      located(v1Properties[key], v1Shape.root, `${path}.${key}`),
      drop,
      `${path}.${key}`,
    )));
  });
}

const v1 = (name: string): Located => ({ schema: pinned[name]!, root: contract });

test("blast-v2#566: v1 presale summaries publish exactly the pinned PresaleSummary", () => {
  const drop = { summary: V1_UNPUBLISHED.summary, "summary.metadata.cover": V1_UNPUBLISHED.cover };
  assert.deepEqual(differences(social("presale-summary"), v1("PresaleSummary"), drop, "summary"), []);
});

test("the v1 list page publishes exactly the pinned PresaleListPage", () => {
  const drop = { page: V1_UNPUBLISHED.page, "page.presales[]": V1_UNPUBLISHED.summary, "page.presales[].metadata.cover": V1_UNPUBLISHED.cover };
  assert.deepEqual(differences(social("presale-list-page"), v1("PresaleListPage"), drop, "page"), []);
});

test("blast-v2#566: the v1 presale detail publishes exactly the pinned PresaleDetail", () => {
  const drop = { "detail.presale": V1_UNPUBLISHED.identity, "detail.activity[].presale": V1_UNPUBLISHED.activity, "detail.terms": V1_UNPUBLISHED.terms, "detail.presale.metadata.cover": V1_UNPUBLISHED.cover };
  assert.deepEqual(differences(social("presale-detail"), v1("PresaleDetail"), drop, "detail"), []);
});

test("the comparison reaches nested shared schemas and refuses a $ref it cannot follow", () => {
  const found = differences(social("presale-summary"), v1("PresaleSummary"), { summary: V1_UNPUBLISHED.summary }, "summary");
  assert.deepEqual(found.map((difference) => difference.split(":")[0]), ["summary.metadata.cover"], "the cover's upload size, found through sale-metadata");
  assert.throws(() => located({ $ref: "https://elsewhere.invalid/x.json" }, {}, "x"), /cannot follow/);
});
