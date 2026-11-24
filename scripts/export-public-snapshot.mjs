#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const source = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const env = {
  PATH: process.env.PATH,
  LC_ALL: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
};

const privatePaths = [
  "docs/architecture/independent-read-serving-tickets.md",
  "docs/architecture/independent-read-serving-validation-plan.md",
  "docs/audits",
  "docs/deploy/evidence",
  "docs/deploy/history",
  "docs/deploy/manifests",
  "docs/deploy/pr150-fresh-packages.md",
  "docs/evidence",
  "docs/mission-control/profile-connections-http-load.md",
  "docs/product",
  "docs/reviews",
  "docs/superpowers",
  "docs/verification",
  "vendor/sdk-pr150",
];
const retainedDocs = new Set(["docs/product/grill-me-and-explainable-discovery.md"]);
const envExamples = new Set([
  "apps/backend-api/.env.example",
  "apps/web/.env.example",
  "apps/workers/.env.example",
]);
const allowedLinks = new Map([
  [".claude/skills/blast-frontend-review", "../../.agents/skills/blast-frontend-review"],
  ["apps/web/test/fixtures/workspace/public", "../../../public"],
]);

function git(...args) {
  const result = spawnSync("git", args, { cwd: source, env, encoding: "utf8", maxBuffer: 8 << 20 });
  if (result.status !== 0) throw new Error(`Git ${args[0]} failed.`);
  return result.stdout;
}

function excluded(path) {
  if (retainedDocs.has(path)) return false;
  if (privatePaths.some((root) => path === root || path.startsWith(`${root}/`))) return true;
  return /^\.env(?:\.|$)/.test(posix.basename(path)) && !envExamples.has(path);
}

function entriesAt(revision) {
  return git("ls-tree", "-r", "-z", "--full-tree", revision).split("\0").filter(Boolean).map((row) => {
    const separator = row.indexOf("\t");
    const [mode, type, oid] = row.slice(0, separator).split(" ");
    const path = row.slice(separator + 1);
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
      throw new Error("The snapshot contains an unsupported Git entry.");
    }
    if (/[\u0000-\u001f\u007f\ufffd\\]/u.test(path) || isAbsolute(path) || posix.normalize(path) !== path) {
      throw new Error("The snapshot contains an unsupported path.");
    }
    return { mode, oid, path };
  });
}

function extract(revision, output, exclusions) {
  // Literal pathspecs keep tree paths from being interpreted as patterns.
  const pathspecs = exclusions.map((path) => `:(top,exclude,literal)${path}`);
  const result = spawnSync("bash", [
    "-o", "pipefail", "-c",
    'git archive --format=tar "$1" -- . "${@:3}" | tar --extract --file=- --directory="$2" --no-same-owner --no-same-permissions',
    "snapshot", revision, output, ...pathspecs,
  ], { cwd: source, env, stdio: ["ignore", "ignore", "pipe"] });
  if (result.status !== 0) throw new Error("Git archive extraction failed.");
}

function manifestDirectories(entries) {
  const directories = new Set([""]);
  for (const { path } of entries) {
    for (let dir = posix.dirname(path); dir !== "." && !directories.has(dir); dir = posix.dirname(dir)) {
      directories.add(dir);
    }
  }
  return directories;
}

function verifyFile(output, entry, algorithm) {
  const { path, mode, oid } = entry;
  const absolutePath = join(output, path);
  const stats = lstatSync(absolutePath);
  const link = mode === "120000";
  if (link ? !stats.isSymbolicLink() : !stats.isFile() || stats.nlink !== 1) {
    throw new Error(`Unexpected file type for ${path}.`);
  }
  if (!link && (stats.mode & 0o777) !== (mode === "100755" ? 0o700 : 0o600)) {
    throw new Error(`Unexpected file permissions for ${path}.`);
  }
  const data = link ? readlinkSync(absolutePath, { encoding: "buffer" }) : readFileSync(absolutePath);
  const exportedOid = createHash(algorithm).update(`blob ${data.length}\0`).update(data).digest("hex");
  if (exportedOid !== oid) throw new Error(`Exported bytes differ from Git for ${path}.`);
}

function verify(output, entries, algorithm) {
  const expected = new Map(entries.map((entry) => [entry.path, entry]));
  const directories = manifestDirectories(entries);
  const pending = [""];
  for (const directory of pending) {
    for (const dirent of readdirSync(join(output, directory), { withFileTypes: true })) {
      const path = posix.join(directory, dirent.name);
      if (dirent.isDirectory()) {
        if (!directories.has(path)) throw new Error("The archive contains an unexpected directory.");
        pending.push(path);
        continue;
      }
      const entry = expected.get(path);
      if (!entry) throw new Error("The archive contains a path outside the manifest.");
      verifyFile(output, entry, algorithm);
      expected.delete(path);
    }
  }
  if (expected.size) throw new Error(`The archive is missing ${expected.size} manifest entries.`);
}

function main() {
  const [mode, revision, destination] = process.argv.slice(2);
  if (process.argv.length !== 5 || mode !== "--candidate" || !destination || !isAbsolute(destination)) {
    throw new Error("Usage: node scripts/export-public-snapshot.mjs --candidate FULL_COMMIT /absolute/new-directory");
  }
  const algorithm = git("rev-parse", "--show-object-format").trim();
  const length = algorithm === "sha256" ? 64 : 40;
  if (!/^[0-9a-f]+$/.test(revision) || revision.length !== length || git("cat-file", "-t", revision).trim() !== "commit") {
    throw new Error("The revision must be the full object ID of a Git commit.");
  }
  const parent = realpathSync(dirname(destination));
  const output = join(parent, basename(destination));
  const enclosingRepo = spawnSync("git", ["-C", parent, "rev-parse", "--absolute-git-dir"], { env, stdio: "ignore" });
  if (enclosingRepo.error || enclosingRepo.status === 0) {
    throw new Error("Choose a destination outside Git repositories and worktrees.");
  }

  const tree = entriesAt(revision);
  const included = tree.filter(({ path }) => !excluded(path));
  const omitted = tree.filter(({ path }) => excluded(path)).map(({ path }) => path);
  for (const { mode, oid, path } of included) {
    if (mode !== "120000") continue;
    const target = git("cat-file", "blob", oid);
    const resolved = posix.normalize(posix.join(posix.dirname(path), target));
    if (allowedLinks.get(path) !== target || !included.some((entry) => entry.path.startsWith(`${resolved}/`))) {
      throw new Error(`Unapproved or broken symbolic link at ${path}.`);
    }
  }

  const licenses = included.filter(({ path }) => /^LICENSE(?:\.(?:md|txt))?$/i.test(path));
  const assets = included.filter(({ path }) => /\.(?:avif|csv|gif|ico|jpe?g|mov|mp4|otf|pdf|pem|png|svg|tgz|ttf|webm|webp|woff2?|zip)$/i.test(path));
  const manifestSha256 = createHash("sha256").update(JSON.stringify(included)).digest("hex");
  process.umask(0o077);
  mkdirSync(output, { mode: 0o700 });
  try {
    extract(revision, output, omitted);
    verify(output, included, algorithm);
  } catch (error) {
    rmSync(output, { recursive: true });
    throw error;
  }

  process.stdout.write(`${JSON.stringify({
    revision,
    status: "private-candidate",
    manifestSha256,
    entries: included.length,
    omitted: omitted.length,
    licenses,
    assetsAwaitingReview: assets,
    publicationChecks: [
      "Confirm source license and asset redistribution rights.",
      "Inspect private data, credentials, and built artifacts on this exact candidate.",
      "Verify a clean build and resolve public documentation links.",
    ],
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
