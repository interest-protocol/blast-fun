// OA-28 M6: the className codemod's engine. `clsx.ts` is the command line;
// `src/components/ui-libraries/clsx-equivalence.test.ts` replays every shape
// it converts. Each conversion is decided from the TypeScript type checker, so
// a site converts only when the new string's classes are the old one's, in
// the same order (`docs/product/social-feed/ui-libraries.md` §3.11).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import ts from "@typescript/typescript6";

/**
 * What a value placed in a class list may be, as the type checker proves it:
 * `class` a CSS-module class its stylesheet defines; `string` any string;
 * `opt` also undefined; `maybe` also null; `falsy` also false; `number` also a
 * number; `cond` anything (only its truthiness is used).
 */
export type Role = "class" | "string" | "opt" | "maybe" | "falsy" | "number" | "cond";

export type SiteKind = "template" | "array-filter-join" | "array-join" | "conditional";

/** One converted shape, with every value abstracted to `$0`, `$1`, …: what the equivalence test replays. */
export type Shape = Readonly<{ kind: SiteKind; before: string; after: string; roles: readonly Role[] }>;

export type Site = Readonly<{
  file: string;
  line: number;
  kind: SiteKind;
  status: "converted" | "skipped";
  reason?: string;
  before: string;
  after?: string;
  shape?: Shape;
}>;

/** A call of a scoped `cx` mapper, its arguments abstracted the same way (string literals kept). */
export type CxShape = Readonly<{ args: string; roles: readonly Role[] }>;

export type FileResult = Readonly<{ file: string; sites: readonly Site[]; output: string | null }>;

export type CodemodResult = Readonly<{
  files: readonly FileResult[];
  cxShapes: readonly CxShape[];
  /** Template-literal classNames left outside the scope (counted, never changed). */
  outOfScope: readonly Readonly<{ file: string; line: number }>[];
}>;

/** The Blast UI and social surfaces: everything under these roots… */
export const DEFAULT_INCLUDE = ["src/components", "src/app"] as const;
/** …except the launchpad and Mission Control, which OA-28's migration does not cover. */
export const DEFAULT_EXCLUDE = [
  "src/components/launchpad",
  "src/components/mission-control",
  "src/app/(launchpad)",
  "src/app/(mission-control)",
] as const;

const CLASS_VARIABLE = /^(?:class(?:Name|es)?|cls)$|Class(?:Name|es)?$/;

// ---------------------------------------------------------------- files

function walk(directory: string, out: string[]): void {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(?:ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

/** The source files in scope, absolute, sorted. */
export function scopeFiles(root: string, include: readonly string[] = DEFAULT_INCLUDE, exclude: readonly string[] = DEFAULT_EXCLUDE): string[] {
  const all: string[] = [];
  for (const entry of include) walk(path.join(root, entry), all);
  const excluded = exclude.map((entry) => path.join(root, entry) + path.sep);
  return [...new Set(all)].filter((file) => !excluded.some((prefix) => file.startsWith(prefix))).sort();
}

function outOfScopeFiles(root: string, include: readonly string[], exclude: readonly string[]): string[] {
  const all: string[] = [];
  for (const entry of include) walk(path.join(root, entry), all);
  const excluded = exclude.map((entry) => path.join(root, entry) + path.sep);
  return all.filter((file) => excluded.some((prefix) => file.startsWith(prefix))).sort();
}

// ---------------------------------------------------------------- CSS modules

const cssCache = new Map<string, ReadonlySet<string> | null>();

function globalSelectorEnd(css: string, at: number): number {
  let depth = 0;
  let end = at;
  for (; end < css.length; end += 1) {
    if (css[end] === "(") depth += 1;
    else if (css[end] === ")" && (depth -= 1) === 0) break;
  }
  return end;
}

/** The local class names a CSS module exports (its `.name` selectors outside `:global(…)`). */
export function cssModuleClasses(file: string): ReadonlySet<string> | null {
  if (cssCache.has(file)) return cssCache.get(file)!;
  if (!existsSync(file)) {
    cssCache.set(file, null);
    return null;
  }
  let css = readFileSync(file, "utf8");
  css = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  css = css.replace(/url\((?:[^()"']|"[^"]*"|'[^']*')*\)/g, " ");
  css = css.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ");
  // Drop `:global(…)` groups (balanced), whose classes are not exported.
  for (;;) {
    const at = css.indexOf(":global(");
    if (at < 0) break;
    const end = globalSelectorEnd(css, at + ":global".length);
    css = css.slice(0, at) + " " + css.slice(end + 1);
  }
  const names = new Set<string>();
  // Only selector text: what precedes each `{`, back to the previous `}`, `{` or `;`.
  for (const match of css.matchAll(/([^{};]*)\{/g)) {
    const selector = match[1]!;
    if (/^\s*@/.test(selector) && !/^\s*@(?:media|supports|container|layer|scope)/.test(selector)) continue;
    for (const name of selector.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)) names.add(name[1]!);
  }
  cssCache.set(file, names);
  return names;
}

// ---------------------------------------------------------------- the program

export function createProgram(root: string, files: readonly string[]): ts.Program {
  const configPath = path.join(root, "tsconfig.json");
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, { noEmit: true, incremental: false }, host);
  if (!parsed) throw new Error(`cannot read ${configPath}`);
  const declarations = parsed.fileNames.filter((file) => file.endsWith(".d.ts"));
  return ts.createProgram({ rootNames: [...declarations, ...files], options: { ...parsed.options, noEmit: true, incremental: false, plugins: [] } });
}

// ---------------------------------------------------------------- types

type Category = "string" | "undefined" | "null" | "false" | "true" | "number" | "other";

function categories(checker: ts.TypeChecker, type: ts.Type, out = new Set<Category>()): Set<Category> {
  if (type.isUnion()) {
    for (const each of type.types) categories(checker, each, out);
    return out;
  }
  const flags = type.flags;
  if (flags & ts.TypeFlags.Never) return out;
  if (flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) out.add("string");
  else if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) out.add("undefined");
  else if (flags & ts.TypeFlags.Null) out.add("null");
  else if (flags & ts.TypeFlags.BooleanLiteral) out.add(checker.typeToString(type) === "false" ? "false" : "true");
  else if (flags & ts.TypeFlags.Boolean) {
    out.add("false");
    out.add("true");
  } else if (flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) out.add("number");
  else if (type.isIntersection() && type.types.some((each) => each.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral))) out.add("string");
  else out.add("other");
  return out;
}

const subset = (found: ReadonlySet<Category>, allowed: readonly Category[]) => new Set(allowed).isSupersetOf(found);

function roleOf(found: ReadonlySet<Category>): Role {
  if (subset(found, ["string"])) return "string";
  if (subset(found, ["string", "undefined"])) return "opt";
  if (subset(found, ["string", "undefined", "null"])) return "maybe";
  if (subset(found, ["string", "undefined", "null", "false"])) return "falsy";
  return "number";
}

const NULLISH: readonly Category[] = ["undefined", "null"];

// ---------------------------------------------------------------- the analysis

class Skip extends Error {}

type Atom = Readonly<{ node: ts.Expression; role: Role; index: number }>;

type Arg =
  | Readonly<{ t: "static"; text: string }>
  | Readonly<{ t: "atom"; atom: Atom }>
  | Readonly<{ t: "and"; cond: Atom; negate: boolean; value: Atom | string }>
  | Readonly<{ t: "cond"; cond: Atom; a: Atom; b: Atom }>
  | Readonly<{ t: "tpl"; parts: readonly (string | Atom)[] }>
  | Readonly<{ t: "call"; node: ts.Expression; atoms: readonly Atom[] }>;

const unwrap = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);

function isEmptyString(node: ts.Expression): boolean {
  const inner = unwrap(node);
  return (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) && inner.text === "";
}

function isNullishLiteral(node: ts.Expression): boolean {
  const inner = unwrap(node);
  return inner.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(inner) && inner.text === "undefined") || inner.kind === ts.SyntaxKind.FalseKeyword;
}

/** Precedence-safe text for the left of `&&` (or its right). */
function andOperand(node: ts.Expression, text: string): string {
  const inner = unwrap(node);
  if (ts.isBinaryExpression(inner)) {
    const op = inner.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.CommaToken || (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment)) {
      return `(${text})`;
    }
    return text;
  }
  if (ts.isConditionalExpression(inner) || ts.isArrowFunction(inner) || ts.isYieldExpression(inner)) return `(${text})`;
  return text;
}

/** `!cond`, written as a person would: `a === b` becomes `a !== b`, `!x` becomes `x`. */
function negated(node: ts.Expression, source: ts.SourceFile): string {
  const inner = unwrap(node);
  if (ts.isBinaryExpression(inner)) {
    const flip: Partial<Record<ts.SyntaxKind, string>> = {
      [ts.SyntaxKind.EqualsEqualsEqualsToken]: "!==",
      [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "===",
      [ts.SyntaxKind.EqualsEqualsToken]: "!=",
      [ts.SyntaxKind.ExclamationEqualsToken]: "==",
    };
    const op = flip[inner.operatorToken.kind];
    if (op) return `${inner.left.getText(source)} ${op} ${inner.right.getText(source)}`;
  }
  if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) return andOperand(inner.operand, inner.operand.getText(source));
  const text = inner.getText(source);
  if (ts.isIdentifier(inner) || ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner) || ts.isCallExpression(inner)) return `!${text}`;
  return `!(${text})`;
}

type SiteContext = {
  readonly source: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly root: string;
  readonly atoms: Map<string, Atom>;
};

function atomOf(context: SiteContext, node: ts.Expression, role: Role): Atom {
  const key = node.getText(context.source).replace(/\s+/g, " ");
  const known = context.atoms.get(key);
  if (known) {
    // The same text twice (`x ? ` ${x}` : ""`) is one value: its role is the wider of the two, and a
    // value that is also tested may be absent (the test is what made it a string where it was printed).
    const order: Role[] = ["class", "string", "opt", "maybe", "falsy", "number"];
    const wider = (a: Role, b: Role): Role => (order.indexOf(a) >= order.indexOf(b) ? a : b);
    let merged: Role;
    if (role === "cond" && known.role === "cond") merged = "cond";
    else if (role === "cond" || known.role === "cond") merged = wider(role === "cond" ? known.role : role, "maybe");
    else merged = wider(role, known.role);
    const atom = { ...known, role: merged };
    context.atoms.set(key, atom);
    return atom;
  }
  const atom: Atom = { node, role, index: context.atoms.size };
  context.atoms.set(key, atom);
  return atom;
}

/** The CSS module behind `styles` in `styles.x` / `styles[x]`, or null when the object is not one. */
function cssModuleOf(context: SiteContext, object: ts.Expression): string | null {
  if (!ts.isIdentifier(object)) return null;
  const symbol = context.checker.getSymbolAtLocation(object);
  const declaration = symbol?.declarations?.[0];
  if (!declaration || !ts.isImportClause(declaration)) return null;
  const specifier = declaration.parent.moduleSpecifier;
  if (!ts.isStringLiteral(specifier) || !specifier.text.endsWith(".module.css")) return null;
  const spec = specifier.text;
  if (spec.startsWith("#web/scripts/")) return path.join(context.root, "scripts", spec.slice("#web/scripts/".length));
  if (spec.startsWith("#web/")) return path.join(context.root, "src", spec.slice("#web/".length));
  return path.resolve(path.dirname(context.source.fileName), spec);
}

function cssAccessKeys(context: SiteContext, inner: ts.PropertyAccessExpression | ts.ElementAccessExpression): string[] {
  if (ts.isPropertyAccessExpression(inner)) return [inner.name.text];
  else {
    const argument = unwrap(inner.argumentExpression);
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return [argument.text];
    else {
      const type = context.checker.getTypeAtLocation(argument);
      const literals = (type.isUnion() ? type.types : [type]).map((each) => (each.isStringLiteral() ? each.value : null));
      if (literals.some((each) => each === null)) throw new Skip(`CSS-module key not provably defined: ${inner.getText(context.source)}`);
      return literals as string[];
    }
  }
}

/**
 * Checks a value the old code put into the string as is. A CSS-module class
 * must be defined by its stylesheet (a missing one reads `undefined`, which the
 * old string printed and `clsx` drops); anything else must be typed a string.
 */
function valueAtom(context: SiteContext, node: ts.Expression, allowed: readonly Category[]): Atom {
  const inner = unwrap(node);
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
    const css = cssModuleOf(context, inner.expression);
    if (css !== null) {
      const classes = cssModuleClasses(css);
      if (!classes) throw new Skip(`CSS module not found: ${path.relative(context.root, css)}`);
      const keys = cssAccessKeys(context, inner);
      const missing = keys.filter((key) => !classes.has(key));
      if (missing.length > 0) throw new Skip(`CSS module ${path.relative(context.root, css)} defines no .${missing.join(", .")}`);
      return atomOf(context, inner, "class");
    }
  }
  const found = categories(context.checker, context.checker.getTypeAtLocation(inner));
  if (!subset(found, allowed)) throw new Skip(`value typed ${context.checker.typeToString(context.checker.getTypeAtLocation(inner))}: ${inner.getText(context.source)}`);
  return atomOf(context, inner, roleOf(found));
}

/**
 * One value of a class list (a template's word, or an array's element) as a
 * `clsx` argument. `allowed` is what the old code printed faithfully.
 */
function classArg(context: SiteContext, node: ts.Expression, allowed: readonly Category[]): Arg {
  const inner = unwrap(node);
  if (ts.isConditionalExpression(inner)) {
    const emptyWhenFalse = isEmptyString(inner.whenFalse) || (allowed.includes("null") && isNullishLiteral(inner.whenFalse));
    const emptyWhenTrue = isEmptyString(inner.whenTrue) || (allowed.includes("null") && isNullishLiteral(inner.whenTrue));
    if (emptyWhenFalse && !emptyWhenTrue) return andArg(context, inner.condition, false, valueAtom(context, inner.whenTrue, allowed));
    if (emptyWhenTrue && !emptyWhenFalse) return andArg(context, inner.condition, true, valueAtom(context, inner.whenFalse, allowed));
    const cond = atomOf(context, inner.condition, "cond");
    return { t: "cond", cond, a: valueAtom(context, inner.whenTrue, allowed), b: valueAtom(context, inner.whenFalse, allowed) };
  }
  if (ts.isBinaryExpression(inner) && isEmptyString(inner.right)) {
    // `x ?? ""` printed "" for null and undefined only; `x || ""` for every falsy value. clsx drops them all.
    if (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return { t: "atom", atom: valueAtom(context, inner.left, [...allowed.filter((each) => each !== "number" && each !== "false"), ...NULLISH]) };
    }
    if (inner.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return { t: "atom", atom: valueAtom(context, inner.left, [...allowed, ...NULLISH, "false", "number"]) };
    }
  }
  return { t: "atom", atom: valueAtom(context, inner, allowed) };
}

/**
 * `cond && value` — or just `value` when the condition only tests that value
 * is there (`x ? ` ${x}` : ""`, `x === undefined ? "" : ` ${x}``): clsx drops an
 * absent value itself. Then the condition is not a value of its own: the
 * shape keeps it written in terms of `x`.
 */
function andArg(context: SiteContext, condition: ts.Expression, negate: boolean, value: Atom | string): Arg {
  if (typeof value !== "string") {
    const test = presenceTest(condition, context.source);
    if (test && test.whenPresent !== negate && test.value.getText(context.source) === value.node.getText(context.source)) {
      const found = categories(context.checker, context.checker.getTypeAtLocation(test.value));
      if (subset(found, ["string", ...test.absent])) return { t: "atom", atom: atomOf(context, value.node, roleOf(found)) };
    }
  }
  return { t: "and", cond: atomOf(context, condition, "cond"), negate, value };
}

type Piece = Readonly<{ kind: "text"; text: string }> | Readonly<{ kind: "expr"; node: ts.Expression }>;

function templatePieces(node: ts.TemplateExpression | ts.NoSubstitutionTemplateLiteral): Piece[] {
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    if (node.rawText !== undefined && node.rawText !== node.text) throw new Skip("escape sequences in a class template");
    return [{ kind: "text", text: node.text }];
  }
  const pieces: Piece[] = [];
  if (node.head.rawText !== undefined && node.head.rawText !== node.head.text) throw new Skip("escape sequences in a class template");
  pieces.push({ kind: "text", text: node.head.text });
  for (const span of node.templateSpans) {
    if (span.literal.rawText !== undefined && span.literal.rawText !== span.literal.text) throw new Skip("escape sequences in a class template");
    pieces.push({ kind: "expr", node: span.expression });
    pieces.push({ kind: "text", text: span.literal.text });
  }
  return pieces;
}

/**
 * `cond ? ` ${x}` : ""` (or `cond ? " x" : ""`, or swapped): a class added
 * after the previous one with its own leading space. Returns the condition,
 * which branch holds the class, and the class.
 */
function suffixConditional(node: ts.Expression): Readonly<{ cond: ts.Expression; negate: boolean; value: ts.Expression | string }> | null {
  const inner = unwrap(node);
  if (!ts.isConditionalExpression(inner)) return null;
  const lead = (branch: ts.Expression): ts.Expression | string | null => {
    const value = unwrap(branch);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      return /^\s+\S/.test(value.text) ? value.text.trim() : null;
    }
    if (ts.isTemplateExpression(value) && /^\s+$/.test(value.head.text) && value.templateSpans.length === 1 && value.templateSpans[0]!.literal.text === "") {
      return value.templateSpans[0]!.expression;
    }
    return null;
  };
  if (isEmptyString(inner.whenFalse)) {
    const value = lead(inner.whenTrue);
    return value === null ? null : { cond: inner.condition, negate: false, value };
  }
  if (isEmptyString(inner.whenTrue)) {
    const value = lead(inner.whenFalse);
    return value === null ? null : { cond: inner.condition, negate: true, value };
  }
  return null;
}

type Word = Array<Readonly<{ kind: "text"; text: string }> | Readonly<{ kind: "expr"; node: ts.Expression }>>;

/** A class template as `clsx` arguments: its words, split where the old string had spaces. */
function templateArgs(context: SiteContext, template: ts.TemplateExpression | ts.NoSubstitutionTemplateLiteral): Arg[] {
  const words: Array<Word | Arg> = [];
  let word: Word = [];
  const flush = () => {
    if (word.length > 0) words.push(word);
    word = [];
  };
  function appendText(text: string) {
    let buffer = "";
    for (const char of text) {
      if (/\s/.test(char)) {
        if (buffer) word.push({ kind: "text", text: buffer });
        buffer = "";
        flush();
      } else buffer += char;
    }
    if (buffer) word.push({ kind: "text", text: buffer });
  }
  for (const piece of templatePieces(template)) {
    if (piece.kind === "text") {
      appendText(piece.text);
      continue;
    }
    const suffix = suffixConditional(piece.node);
    if (suffix) {
      flush();
      const value = typeof suffix.value === "string" ? suffix.value : valueAtom(context, suffix.value, ["string"]);
      words.push(andArg(context, suffix.cond, suffix.negate, value));
      continue;
    }
    word.push(piece);
  }
  flush();

  const args: Arg[] = [];
  function appendWord(each: Word | Arg) {
    if (!Array.isArray(each)) {
      args.push(each);
      return;
    }
    if (each.every((piece) => piece.kind === "text")) {
      const text = each.map((piece) => (piece as { text: string }).text).join("");
      const last = args[args.length - 1];
      if (last?.t === "static") args[args.length - 1] = { t: "static", text: `${last.text} ${text}` };
      else args.push({ t: "static", text });
      return;
    }
    if (each.length === 1) {
      args.push(classArg(context, (each[0] as { node: ts.Expression }).node, ["string"]));
      return;
    }
    for (let index = 1; index < each.length; index += 1) {
      if (each[index]!.kind === "expr" && each[index - 1]!.kind === "expr") {
        throw new Skip("two values joined with no space between them (a helper that adds its own space); convert by hand");
      }
    }
    // Text and values in one word (`mk-${coin}`): kept as a template, so it prints exactly as before.
    args.push({
      t: "tpl",
      parts: each.map((piece) => (piece.kind === "text" ? piece.text : atomOf(context, piece.node, "string"))),
    });
  }
  for (const each of words) appendWord(each);
  return args;
}

function arrayArgs(context: SiteContext, array: ts.ArrayLiteralExpression, allowed: readonly Category[]): Arg[] {
  return array.elements.map((element) => {
    if (ts.isSpreadElement(element)) {
      const type = context.checker.getTypeAtLocation(element.expression);
      const elementType = context.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      if (!elementType || !subset(categories(context.checker, elementType), allowed)) throw new Skip(`spread of ${context.checker.typeToString(type)}`);
      return { t: "call", node: element, atoms: [atomOf(context, element.expression, roleOf(categories(context.checker, elementType)))] } as Arg;
    }
    return classArg(context, element, allowed);
  });
}

/** `[…].filter(Boolean).join(" ")` / `[…].join(" ")`: the array and whether falsy entries were filtered. */
function arrayJoin(node: ts.Expression): Readonly<{ array: ts.ArrayLiteralExpression; filtered: boolean }> | null {
  const inner = unwrap(node);
  if (!ts.isCallExpression(inner) || !ts.isPropertyAccessExpression(inner.expression) || inner.expression.name.text !== "join") return null;
  if (inner.arguments.length !== 1) return null;
  const separator = inner.arguments[0]!;
  if (!(ts.isStringLiteral(separator) || ts.isNoSubstitutionTemplateLiteral(separator)) || separator.text !== " ") return null;
  const target = unwrap(inner.expression.expression);
  if (ts.isArrayLiteralExpression(target)) return { array: target, filtered: false };
  if (
    ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === "filter"
    && target.arguments.length === 1 && ts.isIdentifier(target.arguments[0]!) && target.arguments[0]!.text === "Boolean"
  ) {
    const array = unwrap(target.expression.expression);
    if (ts.isArrayLiteralExpression(array)) return { array, filtered: true };
  }
  return null;
}

// ---------------------------------------------------------------- output

type Mode = Readonly<{ source: ts.SourceFile; clsx: string; shape: boolean }>;

function atomText(atom: Atom, mode: Mode): string {
  return mode.shape ? `$${atom.index}` : atom.node.getText(mode.source);
}

function andArgText(arg: Extract<Arg, { t: "and" }>, mode: Mode): string {
  const cond = mode.shape
    ? `${arg.negate ? "!" : ""}$${arg.cond.index}`
    : arg.negate ? negated(arg.cond.node, mode.source) : andOperand(arg.cond.node, arg.cond.node.getText(mode.source));
  const value = typeof arg.value === "string"
    ? JSON.stringify(arg.value)
    : mode.shape ? atomText(arg.value, mode) : andOperand(arg.value.node, atomText(arg.value, mode));
  return `${cond} && ${value}`;
}

function argText(arg: Arg, mode: Mode): string {
  switch (arg.t) {
    case "static":
      return JSON.stringify(arg.text);
    case "atom":
      return atomText(arg.atom, mode);
    case "and": {
      return andArgText(arg, mode);
    }
    case "cond":
      return `${atomText(arg.cond, mode)} ? ${atomText(arg.a, mode)} : ${atomText(arg.b, mode)}`;
    case "tpl":
      return "`" + arg.parts.map((part) => (typeof part === "string" ? part.replace(/[`\\]|\$\{/g, (m) => "\\" + m) : "${" + atomText(part, mode) + "}")).join("") + "`";
    case "call":
      return mode.shape ? `...$${arg.atoms[0]!.index}` : arg.node.getText(mode.source);
  }
}

function clsxCall(args: readonly Arg[], mode: Mode): string {
  return `${mode.shape ? "clsx" : mode.clsx}(${args.map((arg) => argText(arg, mode)).join(", ")})`;
}

/** The original expression with every atom replaced by its placeholder (the same text is the same value). */
function beforeShape(node: ts.Expression, context: SiteContext): string {
  const source = context.source;
  const start = node.getStart(source);
  let text = node.getText(source);
  const ranges: Array<Readonly<{ from: number; to: number; index: number }>> = [];
  const visit = (each: ts.Node) => {
    const parent = each.parent;
    const isName = (ts.isPropertyAccessExpression(parent) && parent.name === each) || (ts.isPropertyAssignment(parent) && parent.name === each);
    if (each !== node && ts.isExpression(each) && !isName) {
      const atom = context.atoms.get(each.getText(source).replace(/\s+/g, " "));
      if (atom) {
        ranges.push({ from: each.getStart(source) - start, to: each.end - start, index: atom.index });
        return;
      }
    }
    ts.forEachChild(each, visit);
  };
  visit(node);
  ranges.sort((a, b) => b.from - a.from);
  for (const range of ranges) text = text.slice(0, range.from) + `$${range.index}` + text.slice(range.to);
  return text;
}

/** An array written one element per line keeps that layout as clsx arguments: each element's indent, and the bracket's. */
function arrayLayout(source: ts.SourceFile, array: ts.ArrayLiteralExpression): Readonly<{ item: string; close: string }> | null {
  const text = source.getFullText();
  const first = array.elements[0];
  if (!first) return null;
  const indentBefore = (at: number) => {
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    const indent = text.slice(lineStart, at);
    return /^[ \t]*$/.test(indent) ? indent : null;
  };
  const item = indentBefore(first.getStart(source));
  const close = indentBefore(array.end - 1);
  return item !== null && close !== null ? { item, close } : null;
}

// ---------------------------------------------------------------- sites

type Edit = Readonly<{ start: number; end: number; text: string }>;

type Found = Readonly<{ node: ts.Expression; kind: SiteKind }>;

function siteKind(node: ts.Expression): SiteKind | null {
  const inner = unwrap(node);
  if (ts.isTemplateExpression(inner)) return "template";
  const join = arrayJoin(inner);
  if (join) return join.filtered ? "array-filter-join" : "array-join";
  if (ts.isConditionalExpression(inner) && (siteKind(inner.whenTrue) !== null || siteKind(inner.whenFalse) !== null)) return "conditional";
  return null;
}

/** The class lists in a file: `className={…}`, `className: …` and `const …Class(es|Name) = …` values. */
function findSites(source: ts.SourceFile): Found[] {
  const found: Found[] = [];
  const consider = (expression: ts.Expression | undefined) => {
    if (!expression) return;
    const kind = siteKind(expression);
    if (kind) found.push({ node: expression, kind });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "className" && node.initializer && ts.isJsxExpression(node.initializer)) {
      consider(node.initializer.expression);
    } else if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "className") {
      consider(node.initializer);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && CLASS_VARIABLE.test(node.name.text)) {
      consider(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The condition `cond` of `cond ? A : B` tests the value `x` itself (`x`, `!x`,
 * `x === undefined`, `x != null`, …): returns x, whether true means present,
 * and what an absent x may be (a truthiness test lets it be any falsy string,
 * `=== undefined` only undefined).
 */
function presenceTest(node: ts.Expression, source: ts.SourceFile): Readonly<{ value: ts.Expression; whenPresent: boolean; absent: readonly Category[] }> | null {
  const inner = unwrap(node);
  const truthy: readonly Category[] = ["undefined", "null"];
  if (ts.isIdentifier(inner) || ts.isPropertyAccessExpression(inner)) return { value: inner, whenPresent: true, absent: truthy };
  if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = unwrap(inner.operand);
    if (ts.isIdentifier(operand) || ts.isPropertyAccessExpression(operand)) return { value: operand, whenPresent: false, absent: truthy };
  }
  if (!ts.isBinaryExpression(inner)) return null;
  const op = inner.operatorToken.kind;
  const right = inner.right.getText(source);
  if (!((right === "undefined" && (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken))
    || (right === "null" && (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken)))) return null;
  const value = unwrap(inner.left);
  if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value)) return null;
  return {
    value,
    whenPresent: op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken,
    absent: right === "undefined" ? ["undefined"] : ["undefined", "null"],
  };
}

function argsOfClassList(context: SiteContext, node: ts.Expression): Arg[] {
  const inner = unwrap(node);
  if (ts.isTemplateExpression(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return templateArgs(context, inner);
  const join = arrayJoin(inner);
  if (join) return arrayArgs(context, join.array, join.filtered ? ["string", ...NULLISH, "false", "number"] : ["string", ...NULLISH]);
  if (ts.isStringLiteral(inner)) return [{ t: "static", text: inner.text.trim().split(/\s+/).join(" ") }].filter((arg) => arg.text !== "") as Arg[];
  return [{ t: "atom", atom: valueAtom(context, inner, ["string"]) }];
}

const sameArg = (a: Arg, b: Arg, source: ts.SourceFile): boolean => {
  const mode: Mode = { source, clsx: "clsx", shape: false };
  return argText(a, mode) === argText(b, mode);
};

/**
 * `x ? `${a} ${x}` : a` (or `x === undefined ? "a" : `a ${x}``): one list is
 * the other plus `x`, and the condition tests `x` — so it is `clsx(a, x)`.
 * Otherwise each branch converts on its own.
 */
function conditionalArgs(context: SiteContext, node: ts.ConditionalExpression): Arg[] | null {
  const test = presenceTest(node.condition, context.source);
  if (!test) return null;
  const withX = test.whenPresent ? node.whenTrue : node.whenFalse;
  const without = test.whenPresent ? node.whenFalse : node.whenTrue;
  const longer = argsOfClassList(context, withX);
  const shorter = argsOfClassList(context, without);
  if (longer.length !== shorter.length + 1) return null;
  for (let index = 0; index < shorter.length; index += 1) if (!sameArg(longer[index]!, shorter[index]!, context.source)) return null;
  const last = longer[longer.length - 1]!;
  if (last.t !== "atom" || last.atom.node.getText(context.source) !== test.value.getText(context.source)) return null;
  const found = categories(context.checker, context.checker.getTypeAtLocation(test.value));
  if (!subset(found, ["string", ...test.absent])) return null;
  // `x` is printed only when present, so it may be absent: clsx drops it then, as the other branch did.
  const atom = atomOf(context, test.value, roleOf(found));
  return [...shorter, { t: "atom", atom }];
}

function safeConditionalArgs(context: SiteContext, node: ts.ConditionalExpression): Arg[] | null {
  try {
    return conditionalArgs(context, node);
  } catch (error) {
    if (!(error instanceof Skip)) throw error;
    return null;
  }
}

export function analyzeFile(program: ts.Program, file: string, root: string): FileResult {
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`not in the program: ${file}`);
  const checker = program.getTypeChecker();
  const sites: Site[] = [];
  const edits: Edit[] = [];
  const clsxName = existingClsxImport(source);
  const name = clsxName ?? "clsx";
  if (clsxName === null && declaresName(source, "clsx")) {
    return { file, sites: [{ file: path.relative(root, file), line: 1, kind: "template", status: "skipped", reason: "the file declares its own `clsx`", before: "" }], output: null };
  }
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  function conversion(node: ts.Expression, inner: ts.Expression, kind: SiteKind, args: Arg[], context: SiteContext) {
    const source = context.source;
    const mode: Mode = { source, clsx: name, shape: false };
    const layout = kind === "array-filter-join" || kind === "array-join" ? arrayLayout(source, arrayJoin(inner)!.array) : null;
    const after = args.length === 1 && args[0]!.t === "static"
      ? argText(args[0]!, mode)
      : layout
        ? `${name}(\n${args.map((arg) => `${layout.item}${argText(arg, mode)},\n`).join("")}${layout.close})`
        : clsxCall(args, mode);
    const shape: Shape = {
      kind,
      before: beforeShape(node, context),
      after: args.length === 1 && args[0]!.t === "static" ? argText(args[0]!, { ...mode, shape: true }) : clsxCall(args, { ...mode, shape: true }),
      roles: [...context.atoms.values()].sort((a, b) => a.index - b.index).map((atom) => atom.role),
    };
    return { after, shape };
  }
  const handle = (node: ts.Expression, kind: SiteKind) => {
    const context: SiteContext = { source, checker, root, atoms: new Map() };
    const before = node.getText(source);
    try {
      const inner = unwrap(node);
      const args = kind === "conditional"
        ? safeConditionalArgs(context, inner as ts.ConditionalExpression)
        : argsOfClassList(context, inner);
      if (args === null) {
        // Each branch converts on its own.
        const conditional = inner as ts.ConditionalExpression;
        for (const branch of [conditional.whenTrue, conditional.whenFalse]) {
          const branchKind = siteKind(branch);
          if (branchKind) handle(branch, branchKind);
        }
        return;
      }
      if (args.length === 1 && args[0]!.t === "tpl") throw new Skip("a single word built from text and values: nothing for clsx to join");
      const { after, shape } = conversion(node, inner, kind, args, context);
      edits.push({ start: node.getStart(source), end: node.end, text: after });
      sites.push({ file: path.relative(root, file), line: line(node), kind, status: "converted", before, after, shape });
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      sites.push({ file: path.relative(root, file), line: line(node), kind, status: "skipped", reason: error.message, before });
    }
  };
  for (const { node, kind } of findSites(source)) handle(node, kind);
  if (edits.length === 0) return { file, sites, output: null };
  let text = source.getFullText();
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  if (clsxName === null && edits.some((edit) => edit.text.includes("clsx("))) text = addClsxImport(text);
  return { file, sites, output: text };
}

// ---------------------------------------------------------------- imports

function existingClsxImport(source: ts.SourceFile): string | null {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "clsx") continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) return clause.name.text;
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      const binding = clause.namedBindings.elements.find((element) => (element.propertyName ?? element.name).text === "clsx" && !element.isTypeOnly);
      if (binding) return binding.name.text;
    }
  }
  return null;
}

function declaresName(source: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node) || ts.isImportSpecifier(node) || ts.isImportClause(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === name) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Adds `import clsx from "clsx";` among the file's package imports, in
 * alphabetical place; with none, as its own group before the first import.
 */
export function addClsxImport(text: string): string {
  const source = ts.createSourceFile("x.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = source.statements.filter(ts.isImportDeclaration);
  const line = 'import clsx from "clsx";';
  const isPackage = (statement: ts.ImportDeclaration) => {
    const spec = (statement.moduleSpecifier as ts.StringLiteral).text;
    return !spec.startsWith(".") && !spec.startsWith("#web/");
  };
  if (imports.length === 0) {
    const directives = source.statements.filter((statement) => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression));
    const at = directives.length > 0 ? directives[directives.length - 1]!.end : 0;
    return at === 0 ? `${line}\n\n${text}` : `${text.slice(0, at)}\n\n${line}${text.slice(at)}`;
  }
  const packages = imports.filter(isPackage);
  if (packages.length === 0) {
    const first = imports[0]!;
    const start = first.getStart(source);
    return `${text.slice(0, start)}${line}\n\n${text.slice(start)}`;
  }
  // The first run of package imports (no blank line between them).
  const group: ts.ImportDeclaration[] = [packages[0]!];
  for (let index = imports.indexOf(packages[0]!) + 1; index < imports.length; index += 1) {
    const statement = imports[index]!;
    const gap = text.slice(group[group.length - 1]!.end, statement.getStart(source));
    if (!isPackage(statement) || /\n\s*\n/.test(gap)) break;
    group.push(statement);
  }
  const after = group.find((statement) => (statement.moduleSpecifier as ts.StringLiteral).text.localeCompare("clsx") > 0);
  if (after) {
    const start = after.getStart(source);
    return `${text.slice(0, start)}${line}\n${text.slice(start)}`;
  }
  const end = group[group.length - 1]!.end;
  return `${text.slice(0, end)}\n${line}${text.slice(end)}`;
}

// ---------------------------------------------------------------- cx mappers

function cxNames(source: ts.SourceFile, file: string): Set<string> {
  const local = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!/(^|\/)cx$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === "cx") local.add(element.name.text);
  }
  if (path.basename(file) === "cx.ts") local.add("cx");
  return local;
}

/** Every argument shape passed to a scoped `cx` mapper (`presale-pages/cx.ts`, `social/create/cx.ts`). */
function cxShapes(program: ts.Program, file: string): CxShape[] {
  const source = program.getSourceFile(file);
  if (!source) return [];
  const checker = program.getTypeChecker();
  const local = cxNames(source, file);
  if (local.size === 0) return [];
  const shapes: CxShape[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && local.has(node.expression.text)) {
      const roles: Role[] = [];
      const atom = (each: ts.Expression, role: Role) => {
        roles.push(role);
        return `$${roles.length - 1}`;
      };
      const shapeOf = (each: ts.Expression): string => {
        const inner = unwrap(each);
        if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return JSON.stringify(inner.text);
        if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return `${atom(inner.left, "cond")} && ${shapeOf(inner.right)}`;
        if (ts.isConditionalExpression(inner)) return `${atom(inner.condition, "cond")} ? ${shapeOf(inner.whenTrue)} : ${shapeOf(inner.whenFalse)}`;
        if (ts.isTemplateExpression(inner)) {
          return "`" + inner.head.text + inner.templateSpans.map((span) => "${" + atom(span.expression, "string") + "}" + span.literal.text).join("") + "`";
        }
        const found = categories(checker, checker.getTypeAtLocation(inner));
        return atom(inner, subset(found, ["string"]) ? "string" : "maybe");
      };
      shapes.push({ args: node.arguments.map((each) => shapeOf(each)).join(", "), roles });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return shapes;
}

// ---------------------------------------------------------------- the run

export function runCodemod(root: string, options: Readonly<{ include?: readonly string[]; exclude?: readonly string[]; files?: readonly string[] }> = {}): CodemodResult {
  const include = options.include ?? DEFAULT_INCLUDE;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;
  const files = options.files ?? scopeFiles(root, include, exclude);
  const program = createProgram(root, files);
  const results = files.map((file) => analyzeFile(program, file, root));
  const shapes = new Map<string, CxShape>();
  for (const file of files) for (const shape of cxShapes(program, file)) shapes.set(`${shape.args}|${shape.roles.join(",")}`, shape);
  const outOfScope: Array<Readonly<{ file: string; line: number }>> = [];
  if (!options.files) {
    for (const file of outOfScopeFiles(root, include, exclude)) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((each, index) => {
        if (each.includes("className={`")) outOfScope.push({ file: path.relative(root, file), line: index + 1 });
      });
    }
  }
  return { files: results, cxShapes: [...shapes.values()], outOfScope };
}

/** The distinct shapes a run converted, merged with the ones recorded before (so a re-run on a newer tree only adds). */
export function mergeShapes(previous: readonly Shape[], sites: readonly Site[]): Shape[] {
  const all = new Map<string, Shape>();
  for (const shape of previous) all.set(JSON.stringify(shape), shape);
  for (const site of sites) if (site.shape) all.set(JSON.stringify(site.shape), site.shape);
  return [...all.values()].sort((a, b) => (a.kind + a.before).localeCompare(b.kind + b.before));
}
