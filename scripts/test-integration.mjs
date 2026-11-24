// Runs a package's integration tests: every `*.integration.test.ts(x)` under
// its src/ (and scripts/), one file at a time, each against its own throwaway
// Postgres. Prints one line per file and exits non-zero if any file fails, skips or leaves a test todo, or runs none.
//   cd <package> && node ../../scripts/test-integration.mjs [--jobs N] [file ...]
//   npm run test:integration [-w <package>] -- [file ...]   (at the root, --jobs needs `-- -- --jobs N`)
// The root fan-out runs files in their owning workspace. Standalone workspace
// gates may list dependencies and declare the workspace with --owned-by.
//   node scripts/test-integration.mjs --self-check
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Each file keeps the setup of the per-suite script that ran it before: the
// first row whose path prefix (from the repo root) matches wins. Default:
// with-disposable-postgres.sh (which applies the chain fixture), the loader
// hook, and --test-concurrency=1.
const PLAIN = { hooks: false, serial: false };
const SETUP = [
  ["apps/backend-api/test/partner-verifier-role.", { hooks: "runtime", redis: true }],
  ["apps/backend-api/test/", { redis: true, bun: true, timeout: 120000 }],
  ["apps/web/src/app/(launchpad)/coin/coin-route.", { redis: true }],
  ["packages/core/src/lib/web-security/gateway-admission.", { redis: true, hooks: "runtime" }],
  ["packages/core/src/lib/web-security/redis-rate-limits.", { redis: true, hooks: "runtime" }],
  ["packages/core/src/modules/web-security/traffic-rate-limits.", { redis: true }],
  ["packages/core/src/lib/public-read-cache.", { redis: true }],
  // The public read cache requires a real Valkey; no skip.
  ["packages/server/src/modules/public-reads/runtime.", { redis: true }],
  ["packages/server/src/modules/read-routing/replica-streaming.", { ...PLAIN, replica: true }],
  ["packages/server/src/modules/read-routing/", { hooks: false }],
  ["packages/server/src/modules/mission-control/", PLAIN],
  ["apps/web/src/lib/web-security/", PLAIN],
  ["packages/server/src/modules/launchpad-identity/", { hooks: false }],
  ["packages/server/src/modules/launchpad-search/", { hooks: false }],
  ["apps/web/src/modules/launchpad-social/", { hooks: false }],
  ["packages/server/src/modules/social/social-schema.", { hooks: false }],
  ["apps/workers/src/modules/social/", { hooks: false }],
  ["apps/workers/", { hooks: "runtime" }],
  ["packages/server/src/modules/partner-api-keys/", { hooks: "runtime", redis: true }],
  ["apps/web/src/modules/social/commit/commits.integration.", { bun: true, timeout: 120000 }],
  ["packages/server/", { hooks: "runtime" }],
  ["packages/core/src/modules/database/runtime-roles.", { hooks: false }],
  ["packages/core/src/modules/database/", PLAIN],
];

// Files that assert wall-clock time (latency percentiles, recovery within N s, rate windows). With --jobs > 1
// they run alone, one at a time, after the parallel pool, so other files' load cannot fail them.
const EXCLUSIVE = [
  "apps/backend-api/test/load.integration.test.ts",
  "apps/backend-api/test/partner-recognition-resilience.integration.test.ts",
  "apps/backend-api/test/physical.integration.test.ts",
  "packages/core/src/lib/public-read-cache.integration.test.ts",
  "packages/core/src/lib/web-security/redis-rate-limits.integration.test.ts",
  "packages/core/src/modules/database/batched-read.integration.test.ts",
  "packages/server/src/modules/launchpad-telemetry/launchpad-telemetry.integration.test.ts",
];
const exclusive = (file) => EXCLUSIVE.includes(relative(ROOT, file));

function discover(dir) {
  return globSync(["src/**/*.integration.test.{ts,tsx}", "scripts/**/*.integration.test.{ts,tsx}", "test/**/*.integration.test.{ts,tsx}"], { cwd: dir }).sort();
}

function scopeFiles(files, owner, ownedOnly) {
  if (!owner || ownedOnly !== "1") return files;
  return files.filter((file) => relative(ROOT, file).startsWith(owner + sep));
}

function command(file, cwd) {
  const path = relative(ROOT, file);
  const { replica = false, redis = false, hooks = true, serial = true, bun = false, timeout = 30000 } = SETUP.find(([prefix]) => path.startsWith(prefix))?.[1] ?? {};
  return [
    ...(redis ? [join(ROOT, "scripts/with-disposable-redis.sh"), "bash"] : []),
    join(ROOT, "scripts", replica ? "with-streaming-replica.sh" : "with-disposable-postgres.sh"),
    ...(bun ? ["bun", "--no-env-file", "test", "--max-concurrency", "1", "--timeout", String(timeout)] : ["node", "--no-warnings", ...(hooks ? ["--import", join(ROOT, hooks === "runtime" ? "scripts/register-runtime-types.mjs" : "scripts/test-tsx-hooks.mjs")] : []),
    "--test", ...(serial ? ["--test-concurrency=1"] : []), "--experimental-strip-types"]), relative(cwd, file),
  ];
}

// A file fails when it skips a test, leaves one todo, or runs none: every file here runs with its database
// (and Redis where it needs one), so each of those means a test silently stopped running.
// Node prints "ℹ tests N" / "ℹ skipped N" / "ℹ todo N"; bun prints " N skip" / " N todo" / "Ran N tests".
// The summary closes the output, so the last match wins over anything a test logged earlier. A node file with
// no test() calls reports itself as its one passing test ("✔ <file> (…)"), so that counts as none run.
function unrunTests(output, name) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const last = (pattern) => [...text.matchAll(pattern)].at(-1)?.[1];
  const nodeRan = last(/^\S+ tests (\d+)$/gm);
  const ran = nodeRan ?? last(/^Ran (\d+) tests?\b/gm);
  const none = ran === undefined || Number(ran) === 0 || (nodeRan === "1" && text.includes(`\n✔ ${name} (`));
  const count = (node, bun) => Number((nodeRan === undefined ? last(bun) : last(node)) ?? 0);
  return [
    [count(/^\S+ skipped (\d+)$/gm, /^\s*(\d+) skip$/gm), "skipped"],
    [count(/^\S+ todo (\d+)$/gm, /^\s*(\d+) todo$/gm), "todo"],
  ].filter(([n]) => n).map(([n, what]) => `${n} ${what}`).concat(none ? ["no tests ran"] : []);
}

// Output is held back and printed only for a failing file, so --jobs > 1 does not interleave it.
function run(file, cwd) {
  const started = Date.now();
  const child = spawn("bash", command(file, cwd), { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  child.on("error", (error) => output.push(Buffer.from(`${error.message}\n`)));
  return new Promise((done) => child.on("close", (code, signal) => {
    const text = Buffer.concat(output);
    const unrun = unrunTests(`\n${text.toString()}`, relative(cwd, file));
    const ok = code === 0 && unrun.length === 0;
    if (!ok) process.stdout.write(text);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const note = [signal, ...unrun].filter(Boolean).join(", ");
    console.log(`${ok ? "pass" : "FAIL"} ${seconds.padStart(6)}s ${relative(cwd, file)}${note ? ` (${note})` : ""}`);
    done(ok);
  }));
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { jobs: { type: "string", default: "1" }, "owned-by": { type: "string" } },
  });
  const jobs = Number(values.jobs);
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs needs a positive integer, got ${values.jobs}`);
  const cwd = process.cwd();
  // A file argument is read from the package directory, or from where npm was started. At the root, npm
  // hands every argument to every package, so each package runs only the files inside it.
  const inPackage = (file) => /^(apps|packages)\/[^/]+\//.test(relative(ROOT, file));
  const mine = positionals.map((arg) => {
    const found = [resolve(cwd, arg), resolve(process.env.INIT_CWD ?? cwd, arg)].filter((file) => existsSync(file));
    const owned = found.find(inPackage);
    if (!owned) throw new Error(`Not a file in any package: ${arg}`);
    const here = found.find((file) => file.startsWith(cwd + sep));
    if (!here) {
      // npm cannot tell `-w <package>` from the root fan-out, so a file of another package is named, not failed.
      const { name } = JSON.parse(readFileSync(join(ROOT, ...relative(ROOT, owned).split(sep).slice(0, 2), "package.json"), "utf8"));
      console.log(`skip  ${relative(ROOT, owned)} (belongs to ${name}; run it with -w ${name} or from the root)`);
    }
    return here;
  }).filter(Boolean);
  if (positionals.length && !mine.length) return console.log(`${relative(ROOT, cwd)}: no file arguments here, nothing run`);
  const files = positionals.length ? mine : discover(cwd).map((file) => join(cwd, file));

  const owner = values["owned-by"];
  const queue = scopeFiles(files, owner, process.env.BLAST_INTEGRATION_OWNED_ONLY);
  const total = queue.length;
  if (owner && !total) throw new Error(`No integration tests selected for ${owner}`);
  const results = [];
  const pool = queue.filter((file) => !exclusive(file));
  await Promise.all(Array.from({ length: Math.min(jobs, pool.length) }, async () => {
    for (let file; (file = pool.shift());) results.push(await run(file, cwd));
  }));
  for (const file of queue.filter(exclusive)) results.push(await run(file, cwd));
  const failed = results.filter((ok) => !ok).length;
  console.log(`${total} files, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

function selfCheck() {
  const backend = join(ROOT, "apps/backend-api/test/physical.integration.test.ts");
  const dependency = join(ROOT, "packages/core/src/lib/web-security/gateway-admission.integration.test.ts");
  const listed = [backend, dependency];
  assert.deepEqual(scopeFiles(listed, "apps/backend-api", "1"), [backend]);
  assert.deepEqual(scopeFiles(listed, "apps/backend-api", undefined), listed);
  assert.deepEqual(scopeFiles([dependency], undefined, "1"), [dependency]);

  // Include standalone projects in the inventory; workspace execution is separate.
  const found = ["apps/web", "apps/workers", "apps/backend-api", "packages/core", "packages/server", "apps/web/analytics"]
    .flatMap((pkg) => discover(join(ROOT, pkg)).map((file) => `${pkg}/${file}`)).sort();
  const expected = execFileSync("find", ["apps", "packages", "-name", "*.integration.test.ts*", "-not", "-path", "*/node_modules/*"],
    { cwd: ROOT, encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(found, expected);
  for (const [prefix] of SETUP) assert.ok(found.some((file) => file.startsWith(prefix)), `table row matches no file: ${prefix}`);
  for (const file of EXCLUSIVE) assert.ok(found.includes(file), `exclusive file not found: ${file}`);

  const flags = (file) => command(join(ROOT, file), ROOT).join(" ").replaceAll(ROOT, "<root>");
  const db = "<root>/scripts/with-disposable-postgres.sh node --no-warnings";
  const loader = "--import <root>/scripts/test-tsx-hooks.mjs";
  for (const [file, want] of [
    ["apps/web/src/app/(launchpad)/coin/coin-route.integration.test.ts", `<root>/scripts/with-disposable-redis.sh bash ${db} ${loader} --test --test-concurrency=1 --experimental-strip-types`],
    ["apps/web/src/components/social/blast-mode/workspace/PresalesData.integration.test.ts", `${db} ${loader} --test --test-concurrency=1 --experimental-strip-types`],
    ["packages/server/src/modules/social/feed/feed.integration.test.ts", `${db} --import <root>/scripts/register-runtime-types.mjs --test --test-concurrency=1 --experimental-strip-types`],
    ["packages/server/src/modules/read-routing/replica-streaming.integration.test.ts", "<root>/scripts/with-streaming-replica.sh node --no-warnings --test --experimental-strip-types"],
    ["packages/server/src/modules/read-routing/read-routing.integration.test.ts", `${db} --test --test-concurrency=1 --experimental-strip-types`],
    ["apps/web/src/lib/web-security/web-security.integration.test.ts", `${db} --test --experimental-strip-types`],
    ["packages/server/src/modules/launchpad-search/launchpad-search.integration.test.ts", `${db} --test --test-concurrency=1 --experimental-strip-types`],
    ["packages/server/src/modules/launchpad-telemetry/launchpad-telemetry.integration.test.ts", `${db} --import <root>/scripts/register-runtime-types.mjs --test --test-concurrency=1 --experimental-strip-types`],
    ["packages/server/src/modules/social/social-schema.integration.test.ts", `${db} --test --test-concurrency=1 --experimental-strip-types`],
    ["apps/workers/src/modules/social/worker/social-worker.integration.test.ts", `${db} --test --test-concurrency=1 --experimental-strip-types`],
    ["apps/web/src/modules/social/commit/commits.integration.test.ts", "<root>/scripts/with-disposable-postgres.sh bun --no-env-file test --max-concurrency 1 --timeout 120000"],
    ["packages/server/src/modules/partner-api-keys/usage.integration.test.ts", `<root>/scripts/with-disposable-redis.sh bash ${db} --import <root>/scripts/register-runtime-types.mjs --test --test-concurrency=1 --experimental-strip-types`],
    ["packages/core/src/lib/web-security/redis-rate-limits.integration.test.ts", `<root>/scripts/with-disposable-redis.sh bash ${db} --import <root>/scripts/register-runtime-types.mjs --test --test-concurrency=1 --experimental-strip-types`],
    ["packages/core/src/modules/database/runtime-roles.integration.test.ts", `${db} --test --test-concurrency=1 --experimental-strip-types`],
    ["packages/core/src/modules/database/database.integration.test.ts", `${db} --test --experimental-strip-types`],
  ]) assert.equal(flags(file), `${want} ${file}`, file);
  console.log(`self-check ok: ${found.length} files`);
}

if (process.argv.includes("--self-check")) selfCheck();
else await main();
