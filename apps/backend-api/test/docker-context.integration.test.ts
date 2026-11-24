import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

function assertAllowlist(
  names: readonly string[],
  required: ReadonlySet<string>,
  unrelated: readonly string[],
  dockerfile: string,
): void {
  for (const path of unrelated) {
    assert.ok(!names.includes(path), `Unrelated backend context input included: ${path}`);
  }
  assert.ok(
    names.every(
      (path) =>
        path.endsWith("/") ||
        required.has(path) ||
        [".dockerignore", dockerfile, dockerfile + ".dockerignore"].includes(path),
    ),
    "Only declared build inputs reach the daemon.",
  );
}

test(
  "actual Docker context includes COPY inputs and excludes private files without building an image",
  { timeout: 30_000 },
  async (t) => {
    const root = resolve(import.meta.dirname, "../../..");
    const fixture = await mkdtemp(resolve(tmpdir(), "blast-backend-context-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const dockerfile = "apps/backend-api/Dockerfile";
    const source = await readFile(resolve(root, dockerfile), "utf8");
    const runtimeStage = source.slice(source.lastIndexOf("FROM "));
    assert.match(runtimeStage, /FROM oven\/bun:1\.4\.2-slim@sha256:[a-f0-9]{64}/);
    assert.match(runtimeStage, /CMD \["bun", "run", "src\/main.ts"\]/);
    assert.doesNotMatch(
      runtimeStage,
      /BLAST_BACKEND_DEV_PROXY|nginx|apps\/backend-api\/dev\//,
      "Render's edge fronts the API; the image installs no proxy.",
    );
    assert.doesNotMatch(
      runtimeStage,
      /apps\/web\//,
      "Nothing from the web app reaches the production runtime.",
    );
    assert.ok(
      !runtimeStage.includes("register-runtime-types"),
      "Bun needs no Node TypeScript loader.",
    );
    assert.ok(
      runtimeStage.includes("packages/server/src/"),
      "The shared server package is an explicit production input.",
    );
    const required = new Set<string>();

    async function include(path: string): Promise<void> {
      const physical = resolve(root, path);
      const children = await readdir(physical, { withFileTypes: true }).catch(() => null);
      if (children) {
        for (const child of children) {
          await include(path + "/" + child.name);
        }
        return;
      }
      if (/\.test\.tsx?$/.test(path)) {
        return;
      }
      required.add(path);
    }

    for (const line of source.split("\n")) {
      if (line.startsWith("COPY ") && !line.includes("--from=")) {
        for (const path of line.slice(5).trim().split(/\s+/).slice(0, -1)) {
          await include(path.replace(/\/$/, ""));
        }
      }
    }
    const excluded = [
      ".env",
      ".env.production",
      "production.env",
      "production.env.backup",
      "config.env.local",
      "credentials.env",
      "node_modules/private.js",
      ".git/config",
      ".vercel/project.json",
      "outputs/private.json",
      "artifacts/private.json",
    ];
    const privatePaths = [...excluded, ...excluded.map((path) => "apps/backend-api/src/" + path)];
    const unrelated = [
      "apps/web/public/unused-asset.txt",
      "apps/web/src/modules/private-runtime.ts",
      "apps/web/src/lib/private-runtime.ts",
      "scripts/register-runtime-types.mjs",
      "packages/server/src/private-runtime.test.ts",
      "vendor/blast-sdk/old-sdk.tgz",
      "vendor/sdk-pr150/unused-old-sdk.tgz",
      "vendor/sdk-020/README.md",
      "vendor/sdk-pr150-bundled/unused-old-sdk.tgz",
      "unrelated.txt",
      "apps/backend-api/dev/proxy-enabled",
      "apps/backend-api/dev/unused.conf",
    ];
    for (const path of [...required, ...privatePaths, ...unrelated]) {
      await mkdir(dirname(resolve(fixture, path)), { recursive: true });
      await writeFile(resolve(fixture, path), "synthetic-context-fixture");
    }
    await writeFile(resolve(fixture, dockerfile), source);
    await writeFile(
      resolve(fixture, dockerfile + ".dockerignore"),
      await readFile(resolve(root, dockerfile + ".dockerignore")),
    );
    let names: string[] = [];
    const daemon = createServer(async (incoming, outgoing) => {
      if (incoming.url?.includes("/build?")) {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) {
          chunks.push(Buffer.from(chunk));
        }
        const listing = spawnSync("tar", ["-tf", "-"], {
          input: Buffer.concat(chunks),
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        });
        names = listing.stdout
          .split("\n")
          .map((name) => name.replace(/^\.\//, ""))
          .filter(Boolean);
        outgoing.writeHead(listing.status === 0 ? 200 : 500, {
          "Content-Type": "application/json",
        });
        outgoing.end(
          JSON.stringify({
            stream: "Synthetic local Docker context captured; no build executed.\n",
          }) + "\n",
        );
      } else {
        outgoing.writeHead(200, {
          "Content-Type": "application/json",
          "API-Version": "1.47",
          "Docker-Experimental": "false",
        });
        outgoing.end(
          incoming.url?.endsWith("_ping")
            ? "OK"
            : JSON.stringify({
                ApiVersion: "1.47",
                MinAPIVersion: "1.24",
                Version: "synthetic-local-context-only",
              }),
        );
      }
    });
    daemon.listen(0, "127.0.0.1");
    await once(daemon, "listening");
    t.after(
      () =>
        new Promise<void>((done) => {
          daemon.closeIdleConnections();
          daemon.close(() => done());
        }),
    );
    for (const [patternFile, strict] of [
      [".dockerignore", false],
      [dockerfile + ".dockerignore", true],
    ] as const) {
      // Exercise Docker's actual context matcher without executing a build. The
      // legacy transport reads a root ignore file, so mirror the BuildKit-specific
      // patterns there for the second fixture; no repository file is changed.
      await writeFile(
        resolve(fixture, ".dockerignore"),
        await readFile(resolve(root, patternFile)),
      );
      const child = spawn("docker", ["build", "--network=none", "-f", dockerfile, "."], {
        cwd: fixture,
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          DOCKER_BUILDKIT: "0",
          DOCKER_HOST: `tcp://127.0.0.1:${(daemon.address() as { port: number }).port}`,
          DOCKER_CONFIG: resolve(fixture, "empty-config"),
        },
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const [status] = await once(child, "exit");
      assert.equal(status, 0, output);
      for (const path of required) {
        assert.ok(names.includes(path), `Required COPY input excluded: ${path}`);
      }
      for (const path of privatePaths) {
        assert.ok(!names.includes(path), `Private context path included: ${path}`);
      }
      if (strict) {
        assertAllowlist(names, required, unrelated, dockerfile);
      }
    }
    t.diagnostic(
      JSON.stringify({
        requiredCopyFiles: required.size,
        syntheticPrivateFilesExcluded: privatePaths.length,
        actualDockerContext: true,
        rootFallbackAndBackendPatterns: true,
        imageBuilt: false,
      }),
    );
  },
);
