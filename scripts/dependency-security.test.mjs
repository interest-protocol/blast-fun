import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Linter } from "eslint";

const root = new URL("../", import.meta.url);
const readLock = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const lock = readLock("package-lock.json");

test("the dependency graph excludes Hono", () => {
  const hono = /(?:^|\/)(?:hono|@hono\/[^/]+)$/;
  const locks = {
    "package-lock.json": lock,
    "apps/web/analytics/package-lock.json": readLock("apps/web/analytics/package-lock.json"),
  };
  for (const [file, { packages }] of Object.entries(locks)) {
    const resolved = Object.entries(packages).filter(([path, info]) =>
      hono.test(path) || hono.test(info.name ?? ""),
    );
    assert.deepEqual(resolved.map(([path]) => path), [], file);
  }
});

test("Next lint root discovery avoids braces and still enforces internal links", () => {
  assert.ok(!Object.keys(lock.packages).some((path) => path.endsWith("/braces")));
  const require = createRequire(new URL("node_modules/@next/eslint-plugin-next/package.json", root));
  const { getRootDirs } = require("./dist/utils/get-root-dirs.js");
  const directory = mkdtempSync(join(tmpdir(), "blast-lint-glob-"));
  try {
    const web = join(directory, "web");
    const admin = join(directory, "admin");
    mkdirSync(join(web, "pages"), { recursive: true });
    mkdirSync(admin);
    writeFileSync(join(web, "pages", "about.js"), "export default function About() {}\n");
    writeFileSync(join(directory, "not-a-directory"), "");
    const discover = (rootDir) => getRootDirs({ cwd: directory, settings: { next: { rootDir } } }).sort();
    assert.deepEqual(discover(undefined), [directory]);
    assert.deepEqual(discover(web.replaceAll("/", "\\")), [web]);
    assert.deepEqual(discover(`${directory}/*`), [admin, web]);
    assert.deepEqual(discover(`${directory}/{web,admin}`), [admin, web]);
    assert.deepEqual(discover([web, admin]), [admin, web]);
    assert.deepEqual(discover(`${directory}/${"{".repeat(4000)}missing${"}".repeat(4000)}`), []);
    const messages = new Linter().verify('const link = <a href="/about">About</a>;', {
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { next: require(".") },
      settings: { next: { rootDir: `${directory}/{web,admin}` } },
      rules: { "next/no-html-link-for-pages": "error" },
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].ruleId, "next/no-html-link-for-pages");
    assert.equal(messages[0].severity, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("WalletConnect avoids the vulnerable URI decoder and preserves pairing URIs", () => {
  assert.ok(!Object.keys(lock.packages).some((path) => path.endsWith("/decode-uri-component")));
  const utilities = Object.keys(lock.packages).filter((path) => path.endsWith("/@walletconnect/utils"));
  assert.ok(utilities.length > 0);
  const pairing = { protocol: "wc", topic: "topic", version: 2, relay: { protocol: "irn" }, symKey: "ab".repeat(32) };
  for (const path of utilities) {
    const require = createRequire(new URL(`${path}/package.json`, root));
    const { parseUri, formatUri } = require(".");
    const uri = `wc:topic@2?relay-protocol=irn&symKey=${pairing.symKey}`;
    assert.equal(formatUri(pairing), uri);
    const parsed = parseUri(uri);
    for (const key of ["topic", "version", "relay", "symKey"]) assert.deepEqual(parsed[key], pairing[key]);
  }
});
