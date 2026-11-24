import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const WORKERS = join(ROOT, "apps/workers");
const START = "/app/apps/workers/start.sh";
const START_SCRIPT = join(WORKERS, "start.sh");

function deployedWorkers(): string[] {
  const list = spawnSync(START_SCRIPT, ["--list"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(list.status, 0, list.stderr);
  return list.stdout.trim().split("\n");
}

test("every Render worker service starts a listed worker, every listed worker has a service, and start.sh refuses unknown names", () => {
  assert.ok(statSync(START_SCRIPT).mode & 0o111, "start.sh is executable");
  const blueprint = readFileSync(join(ROOT, "render.yaml"), "utf8");
  const started = [...blueprint.matchAll(new RegExp(`dockerCommand: ${START} (\\S+)$`, "gm"))].map((match) => match[1]!);
  assert.deepEqual([...started].sort(), deployedWorkers().sort());

  const usage = spawnSync(START_SCRIPT, ["nope"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /"metric":"worker\.config_error"/);
});

test("the image is pinned, installs without devDependencies, runs as a non-root user in UTC, and copies only files allowed in its build context", () => {
  const dockerfile = readFileSync(join(WORKERS, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:24[.0-9]*-[a-z]+-slim@sha256:[0-9a-f]{64}$/m);
  assert.match(dockerfile, /npm ci --omit=dev/);
  // Only the workers' workspace installs; apps/web/package.json is there for npm ci's
  // lockfile check alone, and the same RUN deletes it, so the image has no apps/web.
  assert.match(dockerfile, /^RUN npm ci --omit=dev [^\n]*--workspace @blast\/workers \\\n {4}&& rm -rf apps\/web \\$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /TZ=UTC/);
  assert.match(dockerfile, new RegExp(`^CMD \\["${START}"\\]$`, "m"));
  const ignore = readFileSync(join(WORKERS, "Dockerfile.dockerignore"), "utf8").split("\n");
  const sources = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \S+$/gm)].flatMap((match) => match[1]!.split(" "));
  assert.ok(sources.length >= 8);
  for (const source of sources) {
    assert.ok(existsSync(join(ROOT, source)), `${source} exists`);
    assert.ok(ignore.includes(`!${source}`), `${source} is in the build context`);
  }
  // npm ci reads every vendored tarball the lockfile resolves, so the image must copy each one's directory.
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
    packages: Record<string, { resolved?: string }>;
  };
  const tarballs = Object.values(lock.packages).flatMap(({ resolved }) => resolved?.startsWith("file:vendor/") ? [resolved.slice("file:".length)] : []);
  assert.ok(tarballs.some((tarball) => tarball.startsWith("vendor/zod-v3/")), "the lockfile includes vendored Zod");
  for (const tarball of tarballs) {
    assert.ok(sources.some((source) => source.endsWith("/") && tarball.startsWith(source)), `${tarball} is copied before npm ci`);
  }
});

/** Record the Node PID and loaded module URLs in the file named by WORKER_TRACE_OUT. */
const TRACE_HOOK = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
appendFileSync(process.env.WORKER_TRACE_OUT, process.pid + "\\n");
registerHooks({ load(url, context, nextLoad) { appendFileSync(process.env.WORKER_TRACE_OUT, url + "\\n"); return nextLoad(url, context); } });
`)}`;

/** The main module each process name must start, and no other worker's. */
const WORKER_MAINS: Readonly<Record<string, string>> = {
  "blast-keeper": "modules/blast-keeper-worker/main.ts",
  "vault-rewards": "modules/vault-rewards/main.ts",
  "rewards-planner": "modules/rewards-planner/main.ts",
  "vault-buyback": "modules/vault-buyback/main.ts",
  social: "modules/social/worker/main.ts",
};

test("each worker loads only its own main module, no devDependency and no .tsx module, so the image's npm ci --omit=dev is enough", () => {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
    packages: Record<string, { dev?: boolean; devOptional?: boolean }>;
  };
  const out = mkdtempSync(join(tmpdir(), "worker-packaging-"));
  try {
    for (const name of deployedWorkers()) {
      const trace = join(out, name);
      const run = spawnSync(START_SCRIPT, [name], {
        cwd: WORKERS,
        encoding: "utf8",
        env: {
          NODE_ENV: "production",
          BLAST_SOCIAL_ENABLED: "true",
          PATH: process.env.PATH,
          NODE_OPTIONS: `--import=${TRACE_HOOK}`,
          WORKER_TRACE_OUT: trace,
        },
        timeout: 60_000,
      });
      assert.equal(run.status, 1, `${name}: ${run.stderr}`);
      assert.match(run.stderr, /"metric":"(?:social\.)?worker\.config_error"/, name);
      const [pid, ...urls] = readFileSync(trace, "utf8").trim().split("\n");
      assert.equal(pid, String(run.pid), `${name} execs Node in the launcher process`);
      assert.ok(urls.length > 20, `${name} loaded its graph`);
      const mains = Object.values(WORKER_MAINS).filter((main) => urls.some((url) => url.endsWith(`/src/${main}`)));
      assert.deepEqual(mains, [WORKER_MAINS[name]], `${name} starts its own worker`);
      assert.deepEqual(urls.filter((url) => url.endsWith(".tsx")), [], name);
      if (name !== "social") assert.deepEqual(urls.filter((url) => /\/node_modules\/@interest-protocol\/blast-(?:util-)?sdk\//.test(url)), [], `${name} loads only the fresh scoped SDK graph`);
      const packages = new Set(
        urls.flatMap((url) => {
          const match = /\/(node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*)\//.exec(url);
          return match ? [match[1]!] : [];
        }),
      );
      for (const path of packages) {
        const lockEntry = lock.packages[path];
        assert.ok(lockEntry, `${path} is in package-lock.json`);
        assert.ok(!lockEntry.dev && !lockEntry.devOptional, `${name} loads devDependency ${path}`);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
