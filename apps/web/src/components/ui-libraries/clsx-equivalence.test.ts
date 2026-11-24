import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import clsx from "clsx";

import type { CxShape, Role, Shape } from "#web/scripts/codemods/clsx-core.ts";
import { scopedCx, type ClassPart } from "./scoped-cx.ts";

/**
 * OA-28 M6: the clsx codemod changed no class. Every shape it converted
 * (`scripts/codemods/clsx-shapes.json`, written by `clsx.ts --write` and merged
 * on every later run) is evaluated both ways — the old template literal or
 * array join, and the new `clsx(…)` — over every value its types allow, and the
 * classes must come out the same, in the same order. Where the old string had
 * no stray spaces it is the same string; otherwise the only difference is the
 * spaces (`"msg "` became `"msg"`). The scoped `cx` mappers are replayed the
 * same way against their old implementation, over every argument shape their
 * callers use.
 */

type Recorded = Readonly<{ shapes: readonly Shape[]; cx: readonly CxShape[] }>;

const recorded: Recorded = JSON.parse(readFileSync(new URL("../../../scripts/codemods/clsx-shapes.json", import.meta.url), "utf8"));

const DOMAINS: Readonly<Record<Role, (index: number) => readonly unknown[]>> = {
  class: (index) => [`M__k${index}`],
  string: (index) => [`s${index}`, `s${index} t${index}`, ""],
  opt: (index) => [`o${index}`, `o${index} p${index}`, "", undefined],
  maybe: (index) => [`m${index}`, `m${index} n${index}`, "", undefined, null],
  falsy: (index) => [`f${index}`, "", undefined, null, false],
  number: (index) => [`n${index}`, "", undefined, null, false, 0, 7, Number.NaN],
  cond: () => [true, false, 0, 1, "", "c", null, undefined, Number.NaN],
};

const tokens = (value: string) => value.split(/\s+/).filter(Boolean);
const clean = (value: string) => value === tokens(value).join(" ");

/** Every combination when there are few; otherwise each value varied alone, plus a seeded sample. */
function* assignments(domains: readonly (readonly unknown[])[]): Generator<unknown[]> {
  const total = domains.reduce((product, domain) => product * domain.length, 1);
  if (total <= 50_000) {
    const at = domains.map(() => 0);
    for (let n = 0; n < total; n += 1) {
      yield at.map((index, place) => domains[place]![index]);
      for (let place = 0; place < at.length; place += 1) {
        at[place]! += 1;
        if (at[place]! < domains[place]!.length) break;
        at[place] = 0;
      }
    }
    return;
  }
  for (let place = 0; place < domains.length; place += 1) {
    for (const value of domains[place]!) yield domains.map((domain, other) => (other === place ? value : domain[0]));
  }
  let seed = 0x6d2b79f5;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let n = 0; n < 20_000; n += 1) yield domains.map((domain) => domain[Math.floor(random() * domain.length)]);
}

const placeholders = (count: number) => Array.from({ length: count }, (_, index) => `$${index}`);

test("OA-28 M6: the codemod recorded the shapes it converted, each value a placeholder with its role", () => {
  assert.ok(recorded.shapes.length > 0);
  for (const shape of recorded.shapes) {
    assert.match(shape.after, /^clsx\(|^"/, shape.after);
    const used = new Set([...`${shape.before} ${shape.after}`.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
    assert.deepEqual([...used].sort((a, b) => a - b), shape.roles.map((_, index) => index), shape.before);
  }
});

test("OA-28 M6: every converted className gives the same classes in the same order, and no stray spaces", (t) => {
  let checked = 0;
  let spacingOnly = 0;
  for (const shape of recorded.shapes) {
    const names = placeholders(shape.roles.length);
    const before = new Function(...names, `return (${shape.before});`) as (...values: unknown[]) => unknown;
    const after = new Function("clsx", ...names, `return (${shape.after});`) as (...values: unknown[]) => unknown;
    const domains = shape.roles.map((role, index) => DOMAINS[role](index));
    let differsInSpacing = false;
    for (const values of assignments(domains)) {
      const old = String(before(...values));
      const next = after(clsx, ...values);
      assert.equal(typeof next, "string");
      const label = `${shape.before}  →  ${shape.after}  with ${JSON.stringify(values)}`;
      assert.deepEqual(tokens(next as string), tokens(old), label);
      assert.ok(clean(next as string), `stray spaces: ${label}`);
      if (clean(old)) assert.equal(next, old, label);
      else differsInSpacing = true;
      checked += 1;
    }
    if (differsInSpacing) spacingOnly += 1;
  }
  assert.ok(checked > recorded.shapes.length);
  // How many shapes printed stray spaces before (and so are not byte-identical strings now): informational.
  t.diagnostic(`${recorded.shapes.length} shapes, ${checked} evaluations, ${spacingOnly} shapes whose old string could carry stray spaces`);
});

/** The mappers' implementation before OA-28 M6, verbatim. */
function legacyCx(styles: Readonly<Record<string, string>>) {
  return (...names: readonly (string | false | null | undefined)[]): string => {
    const out: string[] = [];
    for (const part of names) {
      if (!part) continue;
      for (const name of part.split(" ")) {
        if (!name) continue;
        const scoped = (styles as Record<string, string>)[name];
        out.push(scoped ? `${scoped} ${name}` : name);
      }
    }
    return out.join(" ");
  };
}

/** A module that defines every other name the callers use (so both the mapped and the passed-through paths run). */
function stylesFor(shapes: readonly CxShape[]): Record<string, string> {
  const names = new Set<string>();
  for (const shape of shapes) for (const match of shape.args.matchAll(/"([^"]*)"/g)) for (const name of match[1]!.split(" ")) if (name) names.add(name);
  const styles: Record<string, string> = {};
  [...names].sort().forEach((name, index) => {
    if (index % 2 === 0) styles[name] = `presales-module__x${index}__${name}`;
  });
  styles.s0 = "presales-module__s0";
  styles.m1 = "presales-module__m1";
  return styles;
}

test("OA-28 M6: the scoped cx mappers, now joined by clsx, give the old string for every argument shape their callers use", () => {
  assert.ok(recorded.cx.length > 0);
  const styles = stylesFor(recorded.cx);
  const old = legacyCx(styles);
  const next = scopedCx(styles);
  let checked = 0;
  for (const shape of recorded.cx) {
    const names = placeholders(shape.roles.length);
    const call = new Function("cx", ...names, `return cx(${shape.args});`) as (cx: unknown, ...values: unknown[]) => string;
    const domains = shape.roles.map((role, index) => DOMAINS[role](index));
    for (const values of assignments(domains)) {
      assert.equal(call(next, ...values), call(old, ...values), `cx(${shape.args}) with ${JSON.stringify(values)}`);
      checked += 1;
    }
  }
  assert.ok(checked >= recorded.cx.length);
});

test("OA-28 M6: the scoped cx mappers equal the old implementation on random parts (spaces, empties, falsy values)", () => {
  const pool: ClassPart[] = ["card", "btn btn-primary", " up ", "", null, undefined, false, "a  b", "mk-x", "btn", "  ", "up", "toString"];
  const styles = { card: "M__card", btn: "M__btn", up: "M__up", "mk-x": "M__mk" };
  const old = legacyCx(styles);
  const next = scopedCx(styles);
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let n = 0; n < 5_000; n += 1) {
    const parts = Array.from({ length: Math.floor(random() * 6) }, () => pool[Math.floor(random() * pool.length)]!);
    assert.equal(next(...parts), old(...parts), JSON.stringify(parts));
  }
});

test("OA-28 M6: the leading-space class helpers converted by hand (tintClass, Summary's tint, litClass) give the same strings", () => {
  const before = (tint: boolean | null) => (tint === null ? "" : ` ${tint ? "M__tintUp" : "M__tintDown"}`);
  const after = (tint: boolean | null) => (tint === null ? "" : tint ? "M__tintUp" : "M__tintDown");
  for (const tint of [null, true, false]) {
    for (const price of [true, false]) {
      // LaneCard's Metric: `num${metric.price ? ` ${styles.price}${tintClass(live)}` : ""}`
      assert.equal(clsx("num", price && "M__price", price && after(tint)), `num${price ? ` ${"M__price"}${before(tint)}` : ""}`);
    }
    // PanelContent's Summary: `num ${styles.price}${tint}`, tint defaulting to ""
    assert.equal(clsx("num", "M__price", after(tint)), `num ${"M__price"}${before(tint)}`);
  }
  assert.equal(clsx("num", "M__price", ""), `num ${"M__price"}${""}`);
  for (const lit of ["a", "b", null]) {
    for (const id of ["a", "b"]) {
      // BlastTimeline: `${styles.name}${litClass(id)}`, litClass was `lit === id ? ` ${styles.lit}` : ""`
      assert.equal(clsx("M__name", lit === id && "M__lit"), `${"M__name"}${lit === id ? ` ${"M__lit"}` : ""}`);
    }
  }
});
